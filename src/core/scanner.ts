/**
 * Scanner core — three-pass analysis:
 *
 *   1. Opengrep / Semgrep  — security patterns + OWASP + secrets (always)
 *   2. Bearer              — deep data-flow security (staged/branch/PR)
 *   3. Quality engine      — language-specific linter: Oxlint / Ruff /
 *                            golangci-lint / RuboCop / PMD (staged/branch/PR)
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type {
  Issue, ScanConfig, ScanResult, ScanEngine,
  SemgrepFinding, SemgrepRawResult,
  BearerRawResult, BearerFinding,
} from "../types.js";
import { detectRulesets } from "./detector.js";
import { runQualityScan, isQualityEngineInstalled } from "./quality.js";

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
  if (eligible.length === 0) return empty("No eligible files to scan", t0, config);
  return scanFilesInternal(eligible, cwd, config, t0);
}

async function scanFilesInternal(
  files:  string[],
  cwd:    string,
  config: ScanConfig,
  t0:     number
): Promise<ScanResult> {
  // Pass 1: Opengrep / Semgrep — security patterns (always)
  const primaryResult = await runPrimaryScanner(files, cwd, config, t0);

  // Pass 2: Bearer — deep data-flow (skip for single-file calls — too slow)
  const runBearer  = config.runBearer  ?? (files.length > 1);
  // Pass 3: Quality linter — always run (fast Rust-based tools)
  const runQuality = config.runQuality ?? true;

  const results: ScanResult[] = [primaryResult];

  if (runBearer && isBearerInstalled()) {
    results.push(await runBearerScan(files, cwd, t0));
  }

  if (runQuality) {
    const stackInfo = detectRulesets(cwd);
    const engine    = config.qualityEngine ?? stackInfo.qualityEngine;
    if (engine && isQualityEngineInstalled(engine)) {
      // For large repo scans, tell quality engine to use directory mode (faster, avoids arg-length limits)
      const isRepoScan = config._isRepoScan ?? false;
      results.push(await runQualityScan(files, cwd, engine, t0, isRepoScan));
    }
  }

  return results.length === 1 ? results[0]! : mergeAll(results, t0);
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

  // Pre-commit gate: run Bearer + quality linter (worth the extra seconds)
  return scanFiles(staged, cwd, {
    ...config,
    runBearer:  config.runBearer  ?? true,
    runQuality: config.runQuality ?? true,
  });
}

/** Source file extensions to include in repo scans */
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte",
  "py", "pyi",
  "go",
  "java", "kt", "kts", "groovy",
  "rb",
  "php",
  "sh", "bash",
  "json", "yaml", "yml", "toml",
  "html", "htm",
  "tf", "hcl",      // Terraform
  "sql",
]);

/** Scan the entire repository — all tracked source files in one pass */
export async function scanRepo(cwd: string, config: ScanConfig = {}): Promise<ScanResult> {
  const t0 = Date.now();

  // Collect all git-tracked source files
  let allFiles: string[];
  try {
    const out = execSync("git ls-files --cached", { cwd, encoding: "utf8" });
    allFiles = out.trim().split("\n").filter(Boolean);
  } catch {
    return empty(
      "scan_repo requires a git repository. Navigate to the repo root and try again.",
      t0, config
    );
  }

  // Keep only source code files (skip images, fonts, lock files, etc.)
  const sourceFiles = allFiles.filter((f) => {
    const ext = f.split(".").pop()?.toLowerCase() ?? "";
    return SOURCE_EXTENSIONS.has(ext);
  });

  if (sourceFiles.length === 0) {
    return empty("No source files found in repository.", t0, config);
  }

  // For repo scans always run all three passes
  return scanFilesInternal(sourceFiles, cwd, {
    ...config,
    runBearer:  config.runBearer  ?? true,
    runQuality: config.runQuality ?? true,
    _isRepoScan: true,       // hint for quality engine to use directory mode
  }, t0);
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

  return scanFiles(files, cwd, {
    ...config,
    runBearer:  config.runBearer  ?? true,
    runQuality: config.runQuality ?? true,
  });
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

/** Merge any number of ScanResults, deduplicating by path:line:ruleId */
function mergeAll(results: ScanResult[], t0: number): ScanResult {
  const seen    = new Set<string>();
  const deduped: Issue[] = [];

  for (const r of results) {
    for (const issue of r.issues) {
      const key = `${issue.path}:${issue.line}:${issue.ruleId}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(issue);
      }
    }
  }

  const primary = results[0]!;
  return {
    issues:       deduped,
    skipped:      results.every((r) => r.skipped),
    filesScanned: primary.filesScanned,
    durationMs:   Date.now() - t0,
    rulesets:     [...new Set(results.flatMap((r) => r.rulesets))],
    engines:      [...new Set(results.flatMap((r) => r.engines))],
  };
}

// ─── Scanner detection ────────────────────────────────────────────────────────

function findPrimaryScanner(): { binary: string; engine: ScanEngine } | null {
  const home = homedir();

  // Try opengrep first — has free taint analysis
  // Checks system PATH, Homebrew, and official install location (~/.opengrep/cli/latest/opengrep)
  const opengrepCandidates = [
    "opengrep",
    "/usr/local/bin/opengrep",
    "/opt/homebrew/bin/opengrep",
    join(home, ".opengrep", "cli", "latest", "opengrep"),
    join(home, ".opengrep", "bin", "opengrep"),
    join(home, ".opengrep", "opengrep"),
    join(home, ".local", "bin", "opengrep"),
  ];
  for (const candidate of opengrepCandidates) {
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
