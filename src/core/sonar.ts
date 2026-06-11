/**
 * Pass 6 — SonarQube / SonarCloud integration.
 *
 * Fetches open issues from the Sonar REST API for the scanned files.
 * Supports both SonarCloud (default) and self-hosted SonarQube.
 *
 * Requirements:
 *   SONAR_TOKEN          — user/service token  (set via `argus-ci setup --configure`)
 *   SONAR_PROJECT_KEY    — project key in Sonar (e.g. "myorg_myrepo")
 *
 * Optional:
 *   SONAR_SERVER_URL     — defaults to https://sonarcloud.io
 *   SONAR_ORGANIZATION   — SonarCloud org slug (required for SonarCloud, not SonarQube)
 *
 * Skips gracefully when tokens are missing — zero impact on other passes.
 *
 * ─── API query strategy ──────────────────────────────────────────────────────
 *
 * The SonarCloud /api/issues/search endpoint has two valid query modes:
 *
 *   Repo scan:      componentKeys=<projectKey>
 *                   Returns all open issues for the project.
 *
 *   Targeted scan:  componentKeys=<projectKey>:path/to/file1,<projectKey>:path/to/file2
 *                   Returns issues scoped to those specific files only.
 *
 * Do NOT use the `files` query parameter — it is silently ignored by SonarCloud
 * on /api/issues/search regardless of what the docs say.
 *
 * The path after the colon must be repo-root-relative (e.g. app/Console/Foo.php).
 * SonarCloud stores component keys in this format when sonar.projectBaseDir is the
 * repo root, which is the standard configuration.
 */

import {
  getSonarToken, getSonarProjectKey,
  getSonarServerUrl, getSonarOrganization,
} from "./config.js";
import type { Issue, ScanResult } from "../types.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runSonarCheck(
  files:      string[],
  cwd:        string,
  t0:         number,
  isRepoScan= false
): Promise<ScanResult> {
  const token = getSonarToken();
  if (!token) {
    return skip("SONAR_TOKEN not configured — run `npx argus-ci setup --configure` to add it", t0);
  }

  const projectKey = getSonarProjectKey(cwd);
  if (!projectKey) {
    return skip(
      "SONAR_PROJECT_KEY not set — run `npx argus-ci setup --configure` in this repo to set it, " +
      "or add it to .argus-ci.json: { \"sonarProjectKey\": \"your_project_key\" }",
      t0
    );
  }

  const serverUrl = getSonarServerUrl(cwd).replace(/\/$/, "");
  const org       = getSonarOrganization(cwd);

  // Normalise file paths to repo-root-relative (what SonarCloud uses in component keys)
  const relativeFiles = files.map((f) => toRelativePath(f, cwd));

  // Targeted scans: componentKeys=projectKey:file1,projectKey:file2,...
  // Repo scans:     componentKeys=projectKey  (whole project)
  const componentKeys =
    isRepoScan || relativeFiles.length === 0
      ? projectKey
      : relativeFiles.map((f) => `${projectKey}:${f}`).join(",");

  try {
    // Fetch regular issues (BUG, CODE_SMELL, VULNERABILITY) and Security Hotspots in parallel.
    // Security Hotspots live at a separate endpoint in SonarCloud 10.x — we always fetch both
    // so the count matches what the SonarCloud dashboard shows.
    const [issues, hotspots] = await Promise.all([
      fetchSonarIssues(serverUrl, token, componentKeys, org),
      fetchSonarHotspots(serverUrl, token, projectKey, org, isRepoScan ? undefined : relativeFiles),
    ]);

    let allIssues = [...issues, ...hotspots];

    // Client-side safety net: strip any out-of-scope paths that leaked through.
    // (Handles edge cases like sonar.sources=src where the stored component key path
    // differs from the repo-root-relative path we requested.)
    if (!isRepoScan && relativeFiles.length > 0) {
      allIssues = filterIssuesToFiles(allIssues, relativeFiles);
    }

    return {
      issues: allIssues, skipped: false,
      filesScanned: files.length, durationMs: Date.now() - t0,
      rulesets: [`sonar/${projectKey}`], engines: ["sonar"],
    };
  } catch (err) {
    return skip(`Sonar API error: ${String(err).slice(0, 200)}`, t0);
  }
}

// ─── Client-side safety filter ────────────────────────────────────────────────

/**
 * Filter issues to those whose path matches one of the scanned files.
 * Used as a safety net for sonar.sources edge cases.
 * Accepts exact matches and suffix matches (handles sonar.sources path stripping).
 */
export function filterIssuesToFiles(issues: Issue[], relativeFiles: string[]): Issue[] {
  if (relativeFiles.length === 0) return issues;
  const targets = relativeFiles.map(normalizePath);
  return issues.filter((issue) => {
    const p = normalizePath(issue.path);
    return targets.some((t) => p === t || p.endsWith("/" + t) || t.endsWith("/" + p));
  });
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/** Strip cwd prefix from absolute paths; normalize separators; remove leading ./ */
export function toRelativePath(file: string, cwd: string): string {
  const cwdNorm = cwd.endsWith("/") ? cwd : cwd + "/";
  if (file.startsWith(cwdNorm)) return normalizePath(file.slice(cwdNorm.length));
  if (file.startsWith(cwd) && file[cwd.length] === "/") return normalizePath(file.slice(cwd.length + 1));
  return normalizePath(file);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

// ─── Issues API fetch ─────────────────────────────────────────────────────────

/**
 * Fetch open regular issues (BUG, CODE_SMELL, VULNERABILITY).
 *
 * componentKeys parameter:
 *   - Repo scan:     "projectKey"
 *   - Targeted scan: "projectKey:file1,projectKey:file2,..."
 *
 * Status: use `resolved=false` (stable across all SonarCloud/SonarQube versions).
 * The old `statuses=OPEN,CONFIRMED,REOPENED` is deprecated in SonarCloud 10.2+.
 *
 * Pagination: break on allIssues.length >= paging.total (reliable).
 * Never break on issues.length < PAGE_SIZE — that can fire on a mid-stream partial page.
 */
async function fetchSonarIssues(
  serverUrl:     string,
  token:         string,
  componentKeys: string,
  org:           string | undefined,
): Promise<Issue[]> {
  const allIssues: Issue[] = [];
  let page = 1;
  const PAGE_SIZE = 500;

  while (true) {
    const params = new URLSearchParams({
      componentKeys,
      resolved: "false",
      ps:       String(PAGE_SIZE),
      p:        String(page),
    });

    if (org) params.set("organization", org);

    const url = `${serverUrl}/api/issues/search?${params.toString()}`;
    const res  = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}`,
        Accept:        "application/json",
      },
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (res.status === 401) throw new Error("SONAR_TOKEN is invalid or expired");
      if (res.status === 403) throw new Error("SONAR_TOKEN lacks project browse permission — ensure 'Browse' on the project");
      if (res.status === 404) throw new Error(`Project key not found in Sonar — double-check SONAR_PROJECT_KEY`);
      throw new Error(`Sonar HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const body = await res.json() as SonarResponse;

    if (!body.paging) {
      throw new Error(`Unexpected Sonar response — check SONAR_PROJECT_KEY and SONAR_ORGANIZATION are correct`);
    }

    const issues = body.issues ?? [];
    for (const si of issues) {
      allIssues.push(mapSonarIssue(si));
    }

    if (allIssues.length >= body.paging.total || issues.length === 0) break;
    page++;
  }

  return allIssues;
}

// ─── Security Hotspots API fetch ──────────────────────────────────────────────

/**
 * Fetch Security Hotspots for the project.
 *
 * SonarCloud 10.x moved Security Hotspots to /api/hotspots/search.
 * They are NOT returned by /api/issues/search, which causes the count gap between
 * the SonarCloud dashboard total and what a plain issues/search query returns.
 *
 * For targeted scans we pass `files` (comma-separated repo-relative paths).
 * Unlike /api/issues/search, /api/hotspots/search DOES honor the `files` param.
 * We also apply a client-side filter as a safety net.
 *
 * We fetch only TO_REVIEW hotspots (unreviewed). REVIEWED hotspots have been
 * triaged as SAFE or FIXED and are excluded.
 *
 * Degrades gracefully on older SonarQube where this endpoint may not exist.
 */
async function fetchSonarHotspots(
  serverUrl:     string,
  token:         string,
  projectKey:    string,
  org:           string | undefined,
  relativeFiles: string[] | undefined,  // undefined = repo scan (fetch all)
): Promise<Issue[]> {
  const allHotspots: Issue[] = [];
  let page = 1;
  const PAGE_SIZE = 500;

  while (true) {
    const params = new URLSearchParams({
      projectKey,
      status: "TO_REVIEW",
      ps:     String(PAGE_SIZE),
      p:      String(page),
    });

    if (org) params.set("organization", org);
    // /api/hotspots/search DOES honor the `files` param (unlike issues/search)
    if (relativeFiles && relativeFiles.length > 0) {
      params.set("files", relativeFiles.join(","));
    }

    const url = `${serverUrl}/api/hotspots/search?${params.toString()}`;
    const res  = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}`,
        Accept:        "application/json",
      },
    });

    if (!res.ok) {
      if (res.status === 404 || res.status === 400) break; // endpoint not available on this server
      if (res.status === 401) throw new Error("SONAR_TOKEN is invalid or expired");
      if (res.status === 403) break; // no hotspot view permission — skip silently
      break;
    }

    const body = await res.json() as SonarHotspotsResponse;
    if (!body.paging) break;

    const hotspots = body.hotspots ?? [];
    for (const h of hotspots) {
      allHotspots.push(mapSonarHotspot(h));
    }

    if (allHotspots.length >= body.paging.total || hotspots.length === 0) break;
    page++;
  }

  return allHotspots;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

function mapSonarIssue(si: SonarIssue): Issue {
  // Component format: "projectKey:path/to/file.ts" → strip projectKey: prefix
  const path = si.component.includes(":")
    ? si.component.split(":").slice(1).join(":")
    : si.component;

  return {
    ruleId:   `sonar/${si.rule}`,
    path,
    line:     si.line ?? si.textRange?.startLine ?? 1,
    col:      1,
    severity: mapSonarSeverity(si.severity, si.type),
    message:  `[${si.type}] ${si.message}`,
    engine:   "sonar",
  };
}

function mapSonarHotspot(h: SonarHotspot): Issue {
  const path = h.component.includes(":")
    ? h.component.split(":").slice(1).join(":")
    : h.component;

  const severity: Issue["severity"] =
    h.vulnerabilityProbability === "HIGH"   ? "error"
    : h.vulnerabilityProbability === "MEDIUM" ? "warning"
    : "info";

  return {
    ruleId:   `sonar/${h.ruleKey}`,
    path,
    line:     h.line ?? h.textRange?.startLine ?? 1,
    col:      1,
    severity,
    message:  `[SECURITY_HOTSPOT] ${h.message} (${h.securityCategory}, probability: ${h.vulnerabilityProbability})`,
    engine:   "sonar",
  };
}

function mapSonarSeverity(sev: SonarIssue["severity"], type: SonarIssue["type"]): Issue["severity"] {
  if (type === "VULNERABILITY" || type === "SECURITY_HOTSPOT") return "error";
  if (sev === "BLOCKER" || sev === "CRITICAL") return "error";
  if (sev === "MAJOR")                         return "warning";
  return "info";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function skip(reason: string, t0: number): ScanResult {
  return {
    issues: [], skipped: true, skipReason: reason,
    filesScanned: 0, durationMs: Date.now() - t0,
    rulesets: [], engines: [],
  };
}

// ─── Raw Sonar types ─────────────────────────────────────────────────────────

interface SonarIssue {
  key:        string;
  rule:       string;
  severity:   "BLOCKER" | "CRITICAL" | "MAJOR" | "MINOR" | "INFO";
  component:  string;
  line?:      number;
  message:    string;
  type:       "BUG" | "VULNERABILITY" | "CODE_SMELL" | "SECURITY_HOTSPOT";
  textRange?: { startLine: number };
}

interface SonarResponse {
  issues: SonarIssue[];
  paging: { pageIndex: number; pageSize: number; total: number };
}

interface SonarHotspot {
  key:                      string;
  ruleKey:                  string;
  component:                string;
  line?:                    number;
  message:                  string;
  securityCategory:         string;
  vulnerabilityProbability: "HIGH" | "MEDIUM" | "LOW";
  status:                   "TO_REVIEW" | "REVIEWED";
  textRange?:               { startLine: number };
}

interface SonarHotspotsResponse {
  hotspots: SonarHotspot[];
  paging:   { pageIndex: number; pageSize: number; total: number };
}
