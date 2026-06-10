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

  // Per-repo .argus-ci.json takes priority over global ~/.argus-ci.json
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

  // Build the component path filter from our file list
  // Sonar uses "projectKey:src/path/to/file.ts" format
  const componentFilter = isRepoScan
    ? undefined   // no file filter — fetch all open issues for the project
    : files
        .map((f) => {
          const rel = f.startsWith(cwd) ? f.slice(cwd.length + 1) : f;
          return `${projectKey}:${rel}`;
        })
        .join(",");

  try {
    const issues = await fetchSonarIssues(serverUrl, token, projectKey, org, componentFilter);
    return {
      issues, skipped: false,
      filesScanned: files.length, durationMs: Date.now() - t0,
      rulesets: [`sonar/${projectKey}`], engines: ["sonar"],
    };
  } catch (err) {
    return skip(`Sonar API error: ${String(err).slice(0, 200)}`, t0);
  }
}

// ─── API fetch ────────────────────────────────────────────────────────────────

async function fetchSonarIssues(
  serverUrl:       string,
  token:           string,
  projectKey:      string,
  org:             string | undefined,
  componentFilter: string | undefined,
): Promise<Issue[]> {
  const allIssues: Issue[] = [];
  let page = 1;
  const PAGE_SIZE = 500;

  while (true) {
    // SonarCloud & SonarQube both use `componentKeys` to filter by project or file.
    // `projectKeys` is a deprecated alias that some versions ignore — always use componentKeys.
    const params = new URLSearchParams({
      componentKeys: componentFilter ?? projectKey,  // file filter or whole-project
      statuses:      "OPEN,CONFIRMED,REOPENED",
      resolved:      "false",
      ps:            String(PAGE_SIZE),
      p:             String(page),
    });

    // SonarCloud requires `organization`; self-hosted SonarQube does not need it.
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
      // Surface the raw body in the error so users can debug token/org issues
      if (res.status === 401) throw new Error("SONAR_TOKEN is invalid or expired");
      if (res.status === 403) throw new Error("SONAR_TOKEN lacks project browse permission — ensure 'Browse' on the project");
      if (res.status === 404) throw new Error(`Project key "${projectKey}" not found in Sonar — double-check SONAR_PROJECT_KEY`);
      throw new Error(`Sonar HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const body = await res.json() as SonarResponse;

    // Detect empty/unexpected response (e.g. wrong org, no project access)
    if (!body.paging) {
      throw new Error(`Unexpected Sonar response — check SONAR_PROJECT_KEY and SONAR_ORGANIZATION are correct`);
    }

    const issues = body.issues ?? [];

    for (const si of issues) {
      allIssues.push(mapSonarIssue(si));
    }

    // Stop if we've fetched all pages
    if (page * PAGE_SIZE >= (body.paging?.total ?? 0)) break;
    if (issues.length < PAGE_SIZE)                      break;
    page++;
  }

  return allIssues;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

function mapSonarIssue(si: SonarIssue): Issue {
  // Component format: "projectKey:src/path/to/file.ts" → strip projectKey prefix
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
