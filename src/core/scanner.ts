/**
 * Scanner core — runs Opengrep (primary) or Semgrep (fallback) for pattern-based
 * security analysis, then optionally runs Bearer for deep data-flow analysis.
 *
 * Scanner priority:
 *   1. opengrep  — free taint analysis, drop-in Semgrep replacement
 *   2. semgrep   — fallback if opengrep not installed
 *   3. bearer    — optional second pass, deep data-flow, run on staged/branch/PR
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type {
  Issue, ScanConfig, ScanResult, ScanEngine,
  SemgrepFinding, SemgrepRawResult,
  BearerRawResult, BearerFinding,
} from "../types.js";

const DEFAULT_RULESETS = ["p/secrets", "p/owasp-top-ten", "p/security-audit"];
const DEFAULT_EXCLUDE  = ["node_modules", "dist", ".git", "coverage", "build", ".next", "vendor"];

// ─── Public API ───────────────────────────────────────────────────────────────

export async function scanFiles(
  files:  string[],
  cwd:    string,
  config: ScanConfig = {}
): Promise<ScanResult> {
  const t0 = Date.now();
  const eligible = filterEligible(files, cwd, config);

  if (eligible.length === 0) {
    return empty("No eligible files to scan", t0, config);
  }

  // Run Opengrep/Semgrep
  const primaryResult = await runPrimaryScanner(eligible, cwd, config, t0);

  // Bearer: optional, skip for single-file MCP calls (too slow)
  const runBearer = config.runBearer ?? (eligible.length > 1);
  if (runBearer && isBearerInstalled()) {
    const bearerResult = await runBearerScan(eligible, cwd, t0);
    return mergeResults(primaryResult, bearerResult, t0);
  }

  return primaryResult;
}

export async function scanStaged(cwd: string, config: ScanConfig = {}): Promise<ScanResult> {
  let staged: string[];
  try {
    const out = execSync("git diff --name-only --cached --diff-filter=ACM", { cwd, encoding: "utf8" });
    staged = out.trim().split("\n").filter(Boolean);
  } catch {
    return empty("Not a git repository or no staged files", Date.now(), config);
  }

  if (staged.length === 0) {
    return empty("No staged files", Date.now(), config);
  }

  // Always run Bearer on staged files (this is the pre-commit gate — worth the extra seconds)
  return scanFiles(staged, cwd, { ...config, runBearer: config.runBearer ?? true });
}

export async function scanBranch(
  cwd:    string,
  branch: string,
  base:   string = "main",
  config: ScanConfig = {}
): Promise<ScanResult> {
  let files: string[];
  try {
    const out = execSync(
      `git diff --name-only --diff-filter=ACM $(git merge-base ${base} ${branch}) ${branch}`,
      { cwd, encoding: "utf8" }
    );
    files = out.trim().split("\n").filter(Boolean);
  } catch {
    try {
      const out = execSync(
        `git diff --name-only --diff-filter=ACM ${base}...${branch}`,
        { cwd, encoding: "utf8" }
      );
      files = out.trim().split("\n").filter(Boolean);
    } catch (e) {
      return empty(`Could not diff ${branch} vs ${base}: ${String(e).slice(0, 200)}`, Date.now(), config);
    }
  }

  if (files.length === 0) {
    return empty(`No changed files between ${base} and ${branch}`, Date.now(), config);
  }

  return scanFiles(files, cwd, { ...config, runBearer: config.runBearer ?? true });
}

// ─── Primary scanner (Opengrep / Semgrep) ────────────────────────────────────

async function runPrimaryScanner(
  files:  string[],
  cwd:    string,
  config: ScanConfig,
  t0:     number
): Promise<ScanResult> {
  const scannerInfo = findPrimaryScanner();
  if (!scannerInfo) {
    return {
      issues: [], skipped: true, filesScanned: files.length, durationMs: Date.now() - t0,
      rulesets: [], engines: [],
      skipReason:
        "No scanner found. Install Opengrep (pip install opengrep) or Semgrep (brew install semgrep)",
    };
  }

  const { binary, engine } = scannerInfo;
  const rulesets  = config.rulesets ?? DEFAULT_RULESETS;
  const excludes  = [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])];

  const args: string[] = [
    ...rulesets.flatMap((r) => ["--config", r]),
    "--json",
    "--no-git-ignore",
    "--quiet",
    ...excludes.flatMap((e) => ["--exclude", e]),
    "--",
    ...files,
  ];

  const result = spawnSync(binary, args, {
    cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024,
  });

  if (result.status !== 0 && result.status !== 1) {
    return {
      issues: [], skipped: true, filesScanned: files.length, durationMs: Date.now() - t0,
      rulesets, engines: [],
      skipReason: `${engine} failed (exit ${result.status}): ${(result.stderr ?? "").slice(0, 300)}`,
    };
  }

  let raw: SemgrepRawResult;
  try {
    raw = JSON.parse(result.stdout ?? "") as SemgrepRawResult;
  } catch {
    return {
      issues: [], skipped: true, filesScanned: files.length, durationMs: Date.now() - t0,
      rulesets, engines: [],
      skipReason: `Failed to parse ${engine} output`,
    };
  }

  const issues = raw.results.map((f) => mapSemgrepFinding(f, engine));

  return {
    issues,
    skipped: false,
    filesScanned: files.length,
    durationMs: Date.now() - t0,
    rulesets,
    engines: [engine],
  };
}

// ─── Bearer scanner ───────────────────────────────────────────────────────────

async function runBearerScan(
  files: string[],
  cwd:   string,
  t0:    number
): Promise<ScanResult> {
  const bearerBin = findBearer();
  if (!bearerBin) return empty("Bearer not installed", t0, {});

  // Bearer scans paths/directories — deduplicate to unique directories containing the files
  const paths = [...new Set(files.map((f) => {
    const abs = f.startsWith("/") ? f : join(cwd, f);
    return abs;
  }))];

  const args = [
    "scan",
    "--format", "json",
    "--quiet",
    "--exit-code", "0",   // don't exit 1 on findings — we handle them ourselves
    ...paths,
  ];

  const result = spawnSync(bearerBin, args, {
    cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 60_000,
  });

  if (result.status !== 0) {
    return empty(`Bearer scan failed (exit ${result.status})`, t0, {});
  }

  let raw: BearerRawResult;
  try {
    raw = JSON.parse(result.stdout ?? "") as BearerRawResult;
  } catch {
    return empty("Failed to parse Bearer output", t0, {});
  }

  const issues: Issue[] = [];
  const severityMap: Record<string, Issue["severity"]> = {
    critical: "error",
    high:     "error",
    medium:   "warning",
    low:      "info",
    warning:  "info",
  };

  for (const [sev, findings] of Object.entries(raw)) {
    if (!Array.isArray(findings)) continue;
    for (const f of findings as BearerFinding[]) {
      // Only include files we were asked to scan
      const relPath = f.filename.startsWith(cwd) ? f.filename.slice(cwd.length + 1) : f.filename;
      const included = files.some((file) => relPath.endsWith(file) || file.endsWith(relPath));
      if (!included) continue;

      issues.push({
        ruleId:     `bearer/${f.rule_id}`,
        path:       relPath,
        line:       f.line_number,
        col:        f.column_number ?? 1,
        severity:   severityMap[sev] ?? "warning",
        message:    f.description,
        sourceLine: f.code_extract?.trim(),
        cwe:        f.cwe_ids,
        engine:     "bearer",
      });
    }
  }

  return {
    issues,
    skipped:      false,
    filesScanned: files.length,
    durationMs:   Date.now() - t0,
    rulesets:     ["bearer/built-in"],
    engines:      ["bearer"],
  };
}

// ─── Merge results ────────────────────────────────────────────────────────────

function mergeResults(primary: ScanResult, bearer: ScanResult, t0: number): ScanResult {
  const allIssues = [...primary.issues, ...bearer.issues];
  // Deduplicate: same file + same line from both scanners
  const seen = new Set<string>();
  const deduped = allIssues.filter((i) => {
    const key = `${i.path}:${i.line}:${i.ruleId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    issues:       deduped,
    skipped:      primary.skipped && bearer.skipped,
    filesScanned: primary.filesScanned,
    durationMs:   Date.now() - t0,
    rulesets:     [...new Set([...primary.rulesets, ...bearer.rulesets])],
    engines:      [...new Set([...primary.engines, ...bearer.engines])],
  };
}

// ─── Scanner detection ────────────────────────────────────────────────────────

function findPrimaryScanner(): { binary: string; engine: ScanEngine } | null {
  // Try opengrep first — has free taint analysis
  for (const candidate of ["opengrep", "/usr/local/bin/opengrep", "/opt/homebrew/bin/opengrep"]) {
    const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return { binary: candidate, engine: "opengrep" };
  }

  // Fall back to semgrep
  for (const candidate of ["semgrep", "/usr/local/bin/semgrep", "/opt/homebrew/bin/semgrep"]) {
    const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return { binary: candidate, engine: "semgrep" };
  }

  // Try python module form
  for (const [prog, mod, eng] of [["python3", "opengrep", "opengrep"], ["python3", "semgrep", "semgrep"]] as const) {
    const r = spawnSync(prog, ["-m", mod, "--version"], { encoding: "utf8" });
    if (r.status === 0) return { binary: `${prog} -m ${mod}`, engine: eng as ScanEngine };
  }

  return null;
}

export function isBearerInstalled(): boolean {
  return !!findBearer();
}

function findBearer(): string | null {
  for (const candidate of ["bearer", "/usr/local/bin/bearer", "/opt/homebrew/bin/bearer"]) {
    const r = spawnSync(candidate, ["version"], { encoding: "utf8" });
    if (r.status === 0) return candidate;
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function filterEligible(files: string[], cwd: string, config: ScanConfig): string[] {
  const maxBytes = (config.maxFileSizeKb ?? 500) * 1024;
  return files.filter((f) => {
    const abs = f.startsWith("/") ? f : join(cwd, f);
    if (!existsSync(abs)) return false;
    try { return statSync(abs).size <= maxBytes; } catch { return false; }
  });
}

function empty(reason: string, t0: number, config: ScanConfig): ScanResult {
  return {
    issues: [], skipped: true, skipReason: reason,
    filesScanned: 0, durationMs: Date.now() - t0,
    rulesets: config.rulesets ?? [], engines: [],
  };
}

function mapSemgrepFinding(f: SemgrepFinding, engine: ScanEngine): Issue {
  return {
    ruleId:     f.check_id,
    path:       f.path,
    line:       f.start.line,
    col:        f.start.col,
    severity:   mapSemgrepSeverity(f.extra.severity),
    message:    f.extra.message,
    sourceLine: f.extra.lines?.trim(),
    cwe:        toStringArray(f.extra.metadata?.cwe),
    owasp:      toStringArray(f.extra.metadata?.owasp),
    references: toStringArray(f.extra.metadata?.references),
    engine,
  };
}

function mapSemgrepSeverity(s: SemgrepFinding["extra"]["severity"]): Issue["severity"] {
  if (s === "ERROR")   return "error";
  if (s === "WARNING") return "warning";
  return "info";
}

function toStringArray(val: unknown): string[] | undefined {
  if (!val) return undefined;
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") return [val];
  return undefined;
}
