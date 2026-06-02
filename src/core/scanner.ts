/**
 * Semgrep CLI wrapper.
 * Runs `semgrep --json` on a set of files and returns normalised Issue[].
 *
 * Semgrep must be installed: pip install semgrep  OR  brew install semgrep
 * We check for it on first run and give a clear install message if missing.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Issue, ScanConfig, ScanResult, SemgrepFinding, SemgrepRawResult, Severity } from "../types.js";

const DEFAULT_RULESETS = ["p/secrets", "p/owasp-top-ten"];
const DEFAULT_EXCLUDE  = ["node_modules", "dist", ".git", "coverage", "build", ".next", "vendor"];

// ─── Main export ─────────────────────────────────────────────────────────────

export async function scanFiles(
  files: string[],
  cwd:   string,
  config: ScanConfig = {}
): Promise<ScanResult> {
  const t0 = Date.now();

  // Check semgrep is available
  const semgrepPath = findSemgrep();
  if (!semgrepPath) {
    return {
      issues: [], skipped: true, filesScanned: 0, durationMs: 0, rulesets: [],
      skipReason:
        "semgrep not found. Install with: pip install semgrep  or  brew install semgrep",
    };
  }

  // Filter to files that exist and are under size limit
  const maxBytes = (config.maxFileSizeKb ?? 500) * 1024;
  const eligible = files
    .filter((f) => {
      const abs = f.startsWith("/") ? f : join(cwd, f);
      if (!existsSync(abs)) return false;
      try {
        const stat = readFileSync(abs);
        return stat.length <= maxBytes;
      } catch { return false; }
    });

  if (eligible.length === 0) {
    return { issues: [], skipped: true, skipReason: "No eligible files to scan", filesScanned: 0, durationMs: 0, rulesets: [] };
  }

  const rulesets = config.rulesets ?? DEFAULT_RULESETS;
  const excludes = [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])];

  // Build semgrep command
  const args: string[] = [
    ...rulesets.flatMap((r) => ["--config", r]),
    "--json",
    "--no-git-ignore",     // we control which files to scan explicitly
    "--quiet",
    ...excludes.flatMap((e) => ["--exclude", e]),
    "--",
    ...eligible,
  ];

  const result = spawnSync(semgrepPath, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024, // 50MB
  });

  // semgrep exits 1 when findings are present — that's normal
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (result.status !== 0 && result.status !== 1) {
    // Real error (exit 2+)
    return {
      issues: [], skipped: true, filesScanned: eligible.length, durationMs: Date.now() - t0, rulesets,
      skipReason: `semgrep failed (exit ${result.status}): ${stderr.slice(0, 300)}`,
    };
  }

  let raw: SemgrepRawResult;
  try {
    raw = JSON.parse(stdout) as SemgrepRawResult;
  } catch {
    return {
      issues: [], skipped: true, filesScanned: eligible.length, durationMs: Date.now() - t0, rulesets,
      skipReason: `Failed to parse semgrep output: ${stdout.slice(0, 200)}`,
    };
  }

  const issues = raw.results.map((f) => mapFinding(f, cwd));

  return {
    issues,
    skipped: false,
    filesScanned: eligible.length,
    durationMs: Date.now() - t0,
    rulesets,
  };
}

/**
 * Scans only the git-staged files in cwd.
 * Used by the pre-commit hook.
 */
export async function scanStaged(cwd: string, config: ScanConfig = {}): Promise<ScanResult> {
  let staged: string[];
  try {
    const out = execSync("git diff --name-only --cached --diff-filter=ACM", { cwd, encoding: "utf8" });
    staged = out.trim().split("\n").filter(Boolean);
  } catch {
    return { issues: [], skipped: true, skipReason: "Not a git repository or no staged files", filesScanned: 0, durationMs: 0, rulesets: [] };
  }

  if (staged.length === 0) {
    return { issues: [], skipped: true, skipReason: "No staged files", filesScanned: 0, durationMs: 0, rulesets: [] };
  }

  return scanFiles(staged, cwd, config);
}

/**
 * Scans files changed on a branch vs a base branch.
 */
export async function scanBranch(
  cwd:    string,
  branch: string,
  base:   string = "main",
  config: ScanConfig = {}
): Promise<ScanResult> {
  let files: string[];
  try {
    // Files changed on branch compared to base
    const out = execSync(
      `git diff --name-only --diff-filter=ACM $(git merge-base ${base} ${branch}) ${branch}`,
      { cwd, encoding: "utf8" }
    );
    files = out.trim().split("\n").filter(Boolean);
  } catch (e) {
    // Fallback: diff between branch and base directly
    try {
      const out = execSync(
        `git diff --name-only --diff-filter=ACM ${base}...${branch}`,
        { cwd, encoding: "utf8" }
      );
      files = out.trim().split("\n").filter(Boolean);
    } catch {
      return { issues: [], skipped: true, skipReason: `Could not diff ${branch} vs ${base}: ${String(e).slice(0, 200)}`, filesScanned: 0, durationMs: 0, rulesets: [] };
    }
  }

  if (files.length === 0) {
    return { issues: [], skipped: true, skipReason: `No changed files between ${base} and ${branch}`, filesScanned: 0, durationMs: 0, rulesets: [] };
  }

  // Checkout the branch content to a temp worktree isn't practical;
  // scan the working tree files (they may be on that branch already)
  return scanFiles(files, cwd, config);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findSemgrep(): string | null {
  for (const candidate of ["semgrep", "/usr/local/bin/semgrep", "/opt/homebrew/bin/semgrep"]) {
    try {
      const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
      if (r.status === 0) return candidate;
    } catch { /* continue */ }
  }
  // Try python-installed semgrep
  try {
    const r = spawnSync("python3", ["-m", "semgrep", "--version"], { encoding: "utf8" });
    if (r.status === 0) return "python3 -m semgrep";  // caller handles space
  } catch { /* continue */ }
  return null;
}

function mapFinding(f: SemgrepFinding, cwd: string): Issue {
  return {
    ruleId:      f.check_id,
    path:        f.path,
    line:        f.start.line,
    col:         f.start.col,
    severity:    mapSeverity(f.extra.severity),
    message:     f.extra.message,
    sourceLine:  f.extra.lines?.trim(),
    cwe:         f.extra.metadata?.cwe,
    owasp:       f.extra.metadata?.owasp,
    references:  f.extra.metadata?.references,
  };
}

function mapSeverity(s: SemgrepFinding["extra"]["severity"]): Severity {
  if (s === "ERROR")   return "error";
  if (s === "WARNING") return "warning";
  return "info";
}
