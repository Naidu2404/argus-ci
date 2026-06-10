/**
 * Pass 5 — Dependency vulnerability scanning.
 *
 * Two layers — both run automatically:
 *   Base layer  (zero tokens): npm audit, pip-audit, bundler-audit, cargo audit
 *   Enhanced    (GITHUB_TOKEN): GitHub Dependabot alerts API — richer data,
 *                               CVSS scores, patched versions
 *
 * Returns normalised Issues in the same format as all other passes.
 */

import { spawnSync, execSync } from "child_process";
import { existsSync }          from "fs";
import { join }                from "path";
import { getGithubToken }      from "./config.js";
import type { Issue, ScanResult } from "../types.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runDepsCheck(cwd: string, t0: number): Promise<ScanResult> {
  const results: ScanResult[] = [];

  // Local auditors — no tokens required
  const npm     = runNpmAudit(cwd, t0);
  const pip     = runPipAudit(cwd, t0);
  const bundler = runBundlerAudit(cwd, t0);
  const cargo   = runCargoAudit(cwd, t0);

  results.push(npm, pip, bundler, cargo);

  // Dependabot — richer data when GITHUB_TOKEN is available
  const dependabot = await runDependabotCheck(cwd, t0);
  results.push(dependabot);

  return mergeDepsResults(results, t0);
}

// ─── npm audit ────────────────────────────────────────────────────────────────

function runNpmAudit(cwd: string, t0: number): ScanResult {
  if (!existsSync(join(cwd, "package.json"))) return skipResult("No package.json", t0);

  const hasLock =
    existsSync(join(cwd, "package-lock.json")) ||
    existsSync(join(cwd, "yarn.lock")) ||
    existsSync(join(cwd, "pnpm-lock.yaml")) ||
    existsSync(join(cwd, "bun.lockb"));

  if (!hasLock) return skipResult("No lockfile — run npm install first", t0);

  let stdout = "";
  try {
    // npm audit exits 1 when vulnerabilities found — capture output regardless
    const r = spawnSync("npm", ["audit", "--json"], {
      cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 30_000,
    });
    stdout = r.stdout ?? "";
  } catch {
    return skipResult("npm audit failed", t0);
  }

  if (!stdout.trim()) return cleanResult(t0, "npm-audit");

  let raw: NpmAuditOutput;
  try { raw = JSON.parse(stdout) as NpmAuditOutput; }
  catch { return skipResult("Failed to parse npm audit output", t0); }

  const SEVERITY_ORDER = ["critical", "high", "moderate", "low", "info"];
  const MIN_SEVERITY   = "high"; // only report high+
  const minIdx         = SEVERITY_ORDER.indexOf(MIN_SEVERITY);

  const issues: Issue[] = [];

  for (const [pkgName, vuln] of Object.entries(raw.vulnerabilities ?? {})) {
    const sevIdx = SEVERITY_ORDER.indexOf(vuln.severity);
    if (sevIdx > minIdx) continue;

    const fixable = typeof vuln.fixAvailable === "object"
      ? `Upgrade to ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}`
      : vuln.fixAvailable ? "Run npm audit fix" : "No automatic fix available";

    issues.push({
      ruleId:          `npm-audit/${pkgName}`,
      path:            "package.json",
      line:            1, col: 1,
      severity:        vuln.severity === "critical" || vuln.severity === "high" ? "error" : "warning",
      message:         `[${vuln.severity.toUpperCase()}] Vulnerability in ${pkgName}@${vuln.range}. ${fixable}`,
      engine:          "npm-audit",
    });
  }

  return {
    issues, skipped: false,
    filesScanned: 1, durationMs: Date.now() - t0,
    rulesets: ["npm-audit/advisories"], engines: ["npm-audit"],
  };
}

// ─── pip-audit (Python) ───────────────────────────────────────────────────────

function runPipAudit(cwd: string, t0: number): ScanResult {
  const hasPy =
    existsSync(join(cwd, "requirements.txt")) ||
    existsSync(join(cwd, "pyproject.toml"))    ||
    existsSync(join(cwd, "Pipfile"));

  if (!hasPy) return skipResult("Not a Python project", t0);

  // Try pip-audit first, fall back to safety
  const binary = findBinary(["pip-audit", "safety"]);
  if (!binary) return skipResult("pip-audit not installed (pip install pip-audit)", t0);

  const args = binary.endsWith("safety")
    ? ["check", "--json"]
    : ["--format", "json", "--output", "/dev/stdout"];

  const r = spawnSync(binary, args, {
    cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 60_000,
  });

  const stdout = (r.stdout ?? "").trim();
  if (!stdout) return cleanResult(t0, "pip-audit");

  try {
    const raw = JSON.parse(stdout) as PipAuditOutput[];
    const issues: Issue[] = (raw ?? []).flatMap((item) =>
      (item.vulns ?? []).map((v) => ({
        ruleId:   `pip-audit/${v.id}`,
        path:     "requirements.txt",
        line:     1, col: 1,
        severity: "error" as const,
        message:  `[${v.id}] ${v.description || v.fix_versions?.join(", ") || "Vulnerability"} in ${item.name}@${item.version}`,
        engine:   "pip-audit" as const,
      }))
    );
    return {
      issues, skipped: false,
      filesScanned: 1, durationMs: Date.now() - t0,
      rulesets: ["pip-audit/advisories"], engines: ["pip-audit"],
    };
  } catch {
    return skipResult("Failed to parse pip-audit output", t0);
  }
}

// ─── bundler-audit (Ruby) ─────────────────────────────────────────────────────

function runBundlerAudit(cwd: string, t0: number): ScanResult {
  if (!existsSync(join(cwd, "Gemfile.lock"))) return skipResult("Not a Ruby project", t0);

  const r = spawnSync("bundle", ["audit", "--format", "json"], {
    cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024, timeout: 30_000,
  });

  if (r.error) return skipResult("bundler-audit not installed (gem install bundler-audit)", t0);

  const stdout = (r.stdout ?? "").trim();
  if (!stdout) return cleanResult(t0, "bundler-audit");

  try {
    const raw = JSON.parse(stdout) as { results: Array<{ gem: { name: string; version: string }; advisory: { id: string; title: string; criticality: string } }> };
    const issues: Issue[] = (raw.results ?? []).map((item) => ({
      ruleId:   `bundler-audit/${item.advisory.id}`,
      path:     "Gemfile.lock",
      line:     1, col: 1,
      severity: item.advisory.criticality === "high" || item.advisory.criticality === "critical" ? "error" : "warning",
      message:  `[${item.advisory.id}] ${item.advisory.title} in ${item.gem.name} ${item.gem.version}`,
      engine:   "bundler-audit" as const,
    }));
    return {
      issues, skipped: false,
      filesScanned: 1, durationMs: Date.now() - t0,
      rulesets: ["bundler-audit/advisories"], engines: ["bundler-audit"],
    };
  } catch {
    return skipResult("Failed to parse bundler-audit output", t0);
  }
}

// ─── cargo audit (Rust) ───────────────────────────────────────────────────────

function runCargoAudit(cwd: string, t0: number): ScanResult {
  if (!existsSync(join(cwd, "Cargo.lock"))) return skipResult("Not a Rust project", t0);

  const r = spawnSync("cargo", ["audit", "--json"], {
    cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024, timeout: 60_000,
  });

  if (r.error) return skipResult("cargo-audit not installed (cargo install cargo-audit)", t0);

  const stdout = (r.stdout ?? "").trim();
  if (!stdout) return cleanResult(t0, "cargo-audit");

  try {
    const raw = JSON.parse(stdout) as { vulnerabilities: { list: Array<{ advisory: { id: string; title: string; severity?: string }; package: { name: string; version: string } }> } };
    const issues: Issue[] = (raw.vulnerabilities?.list ?? []).map((item) => ({
      ruleId:   `cargo-audit/${item.advisory.id}`,
      path:     "Cargo.lock",
      line:     1, col: 1,
      severity: item.advisory.severity === "high" || item.advisory.severity === "critical" ? "error" : "warning",
      message:  `[${item.advisory.id}] ${item.advisory.title} in ${item.package.name} ${item.package.version}`,
      engine:   "cargo-audit" as const,
    }));
    return {
      issues, skipped: false,
      filesScanned: 1, durationMs: Date.now() - t0,
      rulesets: ["cargo-audit/advisories"], engines: ["cargo-audit"],
    };
  } catch {
    return skipResult("Failed to parse cargo audit output", t0);
  }
}

// ─── Dependabot (GitHub API) ──────────────────────────────────────────────────

async function runDependabotCheck(cwd: string, t0: number): Promise<ScanResult> {
  const token = getGithubToken();
  if (!token) return skipResult("GITHUB_TOKEN not set — Dependabot alerts skipped (optional)", t0);

  const remote = detectGitHubRemote(cwd);
  if (!remote) return skipResult("Could not detect GitHub owner/repo from git remote", t0);

  const { owner, repo } = remote;

  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/dependabot/alerts?state=open&per_page=100`;
    const res = await fetch(url, {
      headers: {
        Authorization:       `Bearer ${token}`,
        Accept:              "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) {
      const reasons: Record<number, string> = {
        401: "GITHUB_TOKEN is invalid or expired",
        403: "GITHUB_TOKEN lacks 'security_events' read scope",
        404: `Dependabot not enabled on ${owner}/${repo}, or repo not found`,
      };
      return skipResult(reasons[res.status] ?? `GitHub API HTTP ${res.status}`, t0);
    }

    const SORDER = ["critical", "high", "medium", "low"] as const;
    type DSev = typeof SORDER[number];
    const alerts = await res.json() as DependabotAlert[];
    const issues: Issue[] = [];

    for (const alert of alerts) {
      if (alert.state !== "open") continue;
      const sev      = alert.security_vulnerability.severity as DSev;
      const sevIdx   = SORDER.indexOf(sev);
      if (sevIdx > 1) continue; // only critical + high

      const advisory = alert.security_advisory;
      const vuln     = alert.security_vulnerability;
      const dep      = alert.dependency;
      const patched  = vuln.first_patched_version?.identifier;
      const cvss     = advisory.cvss?.score ? ` (CVSS ${advisory.cvss.score})` : "";
      const cve      = advisory.cve_id ? ` ${advisory.cve_id}` : "";

      issues.push({
        ruleId:         `dependabot/${advisory.ghsa_id}`,
        path:           dep.manifest_path || "package.json",
        line:           1, col: 1,
        severity:       sev === "critical" || sev === "high" ? "error" : "warning",
        message:        `[${sev.toUpperCase()}${cve}] ${advisory.summary} in ${dep.package.name}@${vuln.vulnerable_version_range}${cvss}`,
        fixSuggestion:  patched
          ? `Upgrade ${dep.package.name} to ≥ ${patched}`
          : `No patch available yet — monitor ${advisory.ghsa_id}`,
        references:     [alert.html_url],
        engine:         "dependabot",
      });
    }

    return {
      issues, skipped: false,
      filesScanned: 0, durationMs: Date.now() - t0,
      rulesets: ["dependabot/github"], engines: ["dependabot"],
    };
  } catch (err) {
    return skipResult(`Dependabot API error: ${String(err).slice(0, 150)}`, t0);
  }
}

// ─── Merge helper ─────────────────────────────────────────────────────────────

function mergeDepsResults(results: ScanResult[], t0: number): ScanResult {
  const issues:   Issue[]               = [];
  const engines:  ScanResult["engines"] = [];
  const rulesets: string[]              = [];
  let   ranAny    = false;

  for (const r of results) {
    if (!r.skipped) {
      ranAny = true;
      issues.push(...r.issues);
      engines.push(...r.engines);
      rulesets.push(...r.rulesets);
    }
  }

  if (!ranAny) {
    return {
      issues: [], skipped: true,
      skipReason: "No dependency manifest found (package.json / Gemfile / Cargo.toml)",
      filesScanned: 0, durationMs: Date.now() - t0,
      rulesets: [], engines: [],
    };
  }

  return {
    issues, skipped: false,
    filesScanned: results.reduce((s, r) => s + r.filesScanned, 0),
    durationMs: Date.now() - t0,
    rulesets: [...new Set(rulesets)],
    engines:  [...new Set(engines)],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findBinary(names: string[]): string | null {
  for (const name of names) {
    const r = spawnSync("which", [name], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

function detectGitHubRemote(cwd: string): { owner: string; repo: string } | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const https = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (https) return { owner: https[1]!, repo: https[2]! };
    const ssh   = url.match(/git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (ssh)   return { owner: ssh[1]!,   repo: ssh[2]!   };
  } catch { /* ignore */ }
  return null;
}

function skipResult(reason: string, t0: number): ScanResult {
  return {
    issues: [], skipped: true, skipReason: reason,
    filesScanned: 0, durationMs: Date.now() - t0,
    rulesets: [], engines: [],
  };
}

function cleanResult(t0: number, engine: string): ScanResult {
  return {
    issues: [], skipped: false,
    filesScanned: 1, durationMs: Date.now() - t0,
    rulesets: [`${engine}/advisories`], engines: [engine as ScanResult["engines"][number]],
  };
}

// ─── Raw output types ─────────────────────────────────────────────────────────

interface NpmAuditOutput {
  vulnerabilities: Record<string, {
    name: string; severity: string; range: string;
    fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
  }>;
}

interface PipAuditOutput {
  name: string; version: string;
  vulns: Array<{ id: string; description?: string; fix_versions?: string[] }>;
}

interface DependabotAlert {
  number: number; state: string;
  dependency:             { package: { name: string; ecosystem: string }; manifest_path: string };
  security_advisory:      { ghsa_id: string; cve_id: string | null; summary: string; cvss: { score: number } };
  security_vulnerability: { severity: string; vulnerable_version_range: string; first_patched_version: { identifier: string } | null };
  html_url: string;
}
