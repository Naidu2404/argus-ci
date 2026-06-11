/**
 * Scanner core — six-pass analysis:
 *
 *   1. Opengrep / Semgrep  — security patterns + OWASP + secrets (always)
 *   2. Bearer              — deep data-flow security (staged/branch/PR/repo)
 *   3. Quality engine      — Oxlint / Ruff / golangci-lint / RuboCop / PMD / PHPStan
 *   4. Project checks      — ESLint (repo config) + tsc --noEmit + Prettier
 *   5. Dependency audit    — npm audit / pip-audit / bundler-audit + Dependabot
 *   6. Sonar               — SonarQube / SonarCloud (requires SONAR_TOKEN)
 *   +  AI enrichment       — optional fix suggestions via Groq / Anthropic
 */

import { execSync, spawnSync }       from "child_process";
import { existsSync, statSync }      from "fs";
import { join }                      from "path";
import { homedir }                   from "os";
import type {
  Issue, ScanConfig, ScanResult, ScanEngine,
  SemgrepFinding, SemgrepRawResult,
  BearerRawResult, BearerFinding,
} from "../types.js";
import { detectRulesets }            from "./detector.js";
import { runQualityScan, isQualityEngineInstalled } from "./quality.js";
import { runProjectChecks }          from "./project.js";
import { runDepsCheck }              from "./deps.js";
import { runSonarCheck, toRelativePath, filterIssuesToFiles } from "./sonar.js";
import { enrichWithAI }              from "./ai.js";

const DEFAULT_RULESETS = ["p/secrets", "p/owasp-top-ten", "p/security-audit"];
const DEFAULT_EXCLUDE  = ["node_modules", "dist", ".git", "coverage", "build", ".next", "vendor"];

// ─── Public API ───────────────────────────────────────────────────────────────

export async function scanFiles(
  files:  string[],
  cwd:    string,
  config: ScanConfig = {}
): Promise<ScanResult> {
  const t0       = Date.now();
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
  const results: ScanResult[] = [];
  const isRepoScan = config._isRepoScan ?? false;
  const stackInfo  = detectRulesets(cwd);

  // Pass 1: Opengrep / Semgrep — always
  results.push(await runPrimaryScanner(files, cwd, config, t0));

  // Pass 2: Bearer — deep data-flow (skip for single-file calls)
  if ((config.runBearer ?? (files.length > 1)) && isBearerInstalled()) {
    results.push(await runBearerScan(files, cwd, t0));
  }

  // Pass 3: Quality engine (Oxlint / Ruff / golangci-lint / RuboCop / PMD / PHPStan)
  if (config.runQuality ?? true) {
    const engine = config.qualityEngine ?? stackInfo.qualityEngine;
    if (engine && isQualityEngineInstalled(engine)) {
      results.push(await runQualityScan(files, cwd, engine, t0, isRepoScan));
    }
  }

  // Pass 4: Project checks (ESLint + tsc + Prettier using repo's own config)
  if (config.runProject ?? true) {
    results.push(await runProjectChecks(files, cwd, t0, isRepoScan));
  }

  // Pass 5: Dependency audit — only on multi-file or repo scans
  if (config.runDeps ?? (files.length > 1 || isRepoScan)) {
    results.push(await runDepsCheck(cwd, t0));
  }

  // Pass 6: SonarQube / SonarCloud (skips silently if token not configured)
  if (config.runSonar ?? true) {
    results.push(await runSonarCheck(files, cwd, t0, isRepoScan));
  }

  let merged = results.length === 1 ? results[0]! : mergeAll(results, t0);

  // Scope filter: on targeted scans, strip any issues that leaked in from outside
  // the requested file set (e.g. a pass that operates project-wide by design).
  // Dependency audit engines (dependabot, npm-audit, pip-audit, bundler-audit, cargo-audit)
  // are excluded from this filter because they report package-level findings, not file paths.
  if (!isRepoScan && files.length > 0) {
    const relFiles = files.map((f) => toRelativePath(f, cwd));
    const depEngines = new Set(["dependabot", "npm-audit", "pip-audit", "bundler-audit", "cargo-audit"]);
    merged = {
      ...merged,
      issues: merged.issues.filter((issue) => {
        if (depEngines.has(issue.engine ?? "")) return true; // always keep dep findings
        return filterIssuesToFiles([issue], relFiles).length > 0;
      }),
    };
  }

  // AI enrichment — optional, adds fixSuggestion to error-level findings
  if (config.runAI ?? true) {
    merged = await enrichWithAI(merged);
  }

  return merged;
}

/**
 * scanContext — scan the files the AI agent is currently working on.
 * Finds all files modified in the working tree (staged + unstaged) vs HEAD.
 * Also accepts an explicit file list — if provided, those are scanned directly.
 */
export async function scanContext(
  cwd:   string,
  files: string[] | undefined,
  config: ScanConfig = {}
): Promise<ScanResult> {
  // If explicit files were given, just scan them
  if (files && files.length > 0) {
    return scanFiles(files, cwd, config);
  }

  // Otherwise detect modified files from git (staged + unstaged)
  let modified: string[];
  try {
    const staged   = execSync("git diff --name-only --cached --diff-filter=ACM", { cwd, encoding: "utf8" }).trim();
    const unstaged = execSync("git diff --name-only --diff-filter=ACM", { cwd, encoding: "utf8" }).trim();
    const combined = new Set([
      ...staged.split("\n").filter(Boolean),
      ...unstaged.split("\n").filter(Boolean),
    ]);
    modified = [...combined];
  } catch {
    return empty("Not a git repository or no modified files found", Date.now(), config);
  }

  if (modified.length === 0) {
    return empty("No modified files in working tree — nothing to scan", Date.now(), config);
  }

  return scanFiles(modified, cwd, config);
}

export async function scanStaged(cwd: string, config: ScanConfig = {}): Promise<ScanResult> {
  let staged: string[];
  try {
    const out = execSync("git diff --name-only --cached --diff-filter=ACM", { cwd, encoding: "utf8" });
    staged    = out.trim().split("\n").filter(Boolean);
  } catch {
    return empty("Not a git repository or no staged files", Date.now(), config);
  }

  if (staged.length === 0) return empty("No staged files", Date.now(), config);

  return scanFiles(staged, cwd, {
    ...config,
    runBearer:  config.runBearer  ?? true,
    runQuality: config.runQuality ?? true,
    runProject: config.runProject ?? true,
    runDeps:    config.runDeps    ?? true,
    runSonar:   config.runSonar   ?? true,
  });
}

/** Source extensions included in repo scans */
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte",
  "py", "pyi", "go",
  "java", "kt", "kts", "groovy",
  "rb", "php",
  "sh", "bash",
  "json", "yaml", "yml", "toml",
  "html", "htm",
  "tf", "hcl", "sql",
  "cs", "cpp", "c", "swift", "rs",
]);

export async function scanRepo(cwd: string, config: ScanConfig = {}): Promise<ScanResult> {
  const t0 = Date.now();

  let allFiles: string[];
  try {
    const out = execSync("git ls-files --cached", { cwd, encoding: "utf8" });
    allFiles  = out.trim().split("\n").filter(Boolean);
  } catch {
    return empty("scan_repo requires a git repository. Navigate to the repo root and try again.", t0, config);
  }

  const sourceFiles = allFiles.filter((f) => {
    const ext = f.split(".").pop()?.toLowerCase() ?? "";
    return SOURCE_EXTENSIONS.has(ext);
  });

  if (sourceFiles.length === 0) return empty("No source files found in repository.", t0, config);

  return scanFilesInternal(sourceFiles, cwd, {
    ...config,
    runBearer:  true, runQuality: true,
    runProject: true, runDeps:    true,
    runSonar:   true, runAI:      true,
    _isRepoScan: true,
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

  if (files.length === 0) return empty(`No changed files between ${base} and ${branch}`, Date.now(), config);

  return scanFiles(files, cwd, {
    ...config,
    runBearer: true, runQuality: true,
    runProject: true, runDeps: true, runSonar: true,
  });
}

// ─── Primary scanner (Opengrep / Semgrep) ────────────────────────────────────

async function runPrimaryScanner(
  files:  string[], cwd: string, config: ScanConfig, t0: number
): Promise<ScanResult> {
  const scannerInfo = findPrimaryScanner();
  if (!scannerInfo) {
    return {
      issues: [], skipped: true, filesScanned: files.length, durationMs: Date.now() - t0,
      rulesets: [], engines: [],
      skipReason: "No scanner found. Run `npx argus-ci setup` to install Opengrep.",
    };
  }

  const { binary, engine } = scannerInfo;
  const rulesets = config.rulesets ?? DEFAULT_RULESETS;
  const excludes = [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])];

  const args: string[] = [
    ...rulesets.flatMap((r) => ["--config", r]),
    "--json", "--no-git-ignore", "--quiet",
    ...excludes.flatMap((e) => ["--exclude", e]),
    "--", ...files,
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
  try { raw = JSON.parse(result.stdout ?? "") as SemgrepRawResult; }
  catch {
    return {
      issues: [], skipped: true, filesScanned: files.length, durationMs: Date.now() - t0,
      rulesets, engines: [], skipReason: `Failed to parse ${engine} output`,
    };
  }

  return {
    issues: raw.results.map((f) => mapSemgrepFinding(f, engine)),
    skipped: false, filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets, engines: [engine],
  };
}

// ─── Bearer scanner ───────────────────────────────────────────────────────────

async function runBearerScan(files: string[], cwd: string, t0: number): Promise<ScanResult> {
  const bearerBin = findBearer();
  if (!bearerBin) return empty("Bearer not installed", t0, {});

  const paths = [...new Set(files.map((f) => f.startsWith("/") ? f : join(cwd, f)))];
  const result = spawnSync(
    bearerBin, ["scan", "--format", "json", "--quiet", "--exit-code", "0", ...paths],
    { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 60_000 }
  );

  if (result.status !== 0) return empty(`Bearer scan failed (exit ${result.status})`, t0, {});

  let raw: BearerRawResult;
  try { raw = JSON.parse(result.stdout ?? "") as BearerRawResult; }
  catch { return empty("Failed to parse Bearer output", t0, {}); }

  const issues: Issue[] = [];
  const sMap: Record<string, Issue["severity"]> = {
    critical: "error", high: "error", medium: "warning", low: "info", warning: "info",
  };

  for (const [sev, findings] of Object.entries(raw)) {
    if (!Array.isArray(findings)) continue;
    for (const f of findings as BearerFinding[]) {
      const relPath  = f.filename.startsWith(cwd) ? f.filename.slice(cwd.length + 1) : f.filename;
      const included = files.some((file) => relPath.endsWith(file) || file.endsWith(relPath));
      if (!included) continue;
      issues.push({
        ruleId: `bearer/${f.rule_id}`, path: relPath,
        line: f.line_number, col: f.column_number ?? 1,
        severity: sMap[sev] ?? "warning",
        message: f.description, sourceLine: f.code_extract?.trim(),
        cwe: f.cwe_ids, engine: "bearer",
      });
    }
  }

  return {
    issues, skipped: false, filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets: ["bearer/built-in"], engines: ["bearer"],
  };
}

// ─── Merge results ────────────────────────────────────────────────────────────

function mergeAll(results: ScanResult[], t0: number): ScanResult {
  const seen    = new Set<string>();
  const deduped: Issue[] = [];

  for (const r of results) {
    for (const issue of r.issues) {
      const key = `${issue.path}:${issue.line}:${issue.ruleId}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(issue); }
    }
  }

  // Collect skip reasons from each pass so the reporter can surface them.
  // We key each reason by its engine name (inferred from rulesets or a short skip-reason parse).
  const skippedEngines: Record<string, string> = {};
  for (const r of results) {
    if (r.skipped && r.skipReason) {
      // Best-effort engine name from the skip reason prefix
      const engineKey = inferSkippedEngine(r.skipReason);
      skippedEngines[engineKey] = r.skipReason;
    }
  }

  const primary = results[0]!;
  return {
    issues:         deduped,
    skipped:        results.every((r) => r.skipped),
    filesScanned:   primary.filesScanned,
    durationMs:     Date.now() - t0,
    rulesets:       [...new Set(results.flatMap((r) => r.rulesets))],
    engines:        [...new Set(results.flatMap((r) => r.engines))],
    skippedEngines: Object.keys(skippedEngines).length > 0 ? skippedEngines : undefined,
  };
}

function inferSkippedEngine(reason: string): string {
  if (/sonar/i.test(reason))    return "sonar";
  if (/tsc|typescript/i.test(reason)) return "tsc";
  if (/eslint/i.test(reason))   return "eslint";
  if (/prettier/i.test(reason)) return "prettier";
  if (/bearer/i.test(reason))   return "bearer";
  if (/groq|anthropic|ai/i.test(reason)) return "ai";
  if (/dependabot|github/i.test(reason)) return "dependabot";
  if (/npm.audit/i.test(reason)) return "npm-audit";
  if (/pip.audit/i.test(reason)) return "pip-audit";
  if (/opengrep|semgrep/i.test(reason)) return "opengrep";
  // Fallback: use first word of reason
  return reason.split(/[\s:]/)[0]?.toLowerCase() ?? "unknown";
}

// ─── Scanner detection ────────────────────────────────────────────────────────

function findPrimaryScanner(): { binary: string; engine: ScanEngine } | null {
  const home = homedir();
  const opengrep = [
    "opengrep", "/usr/local/bin/opengrep", "/opt/homebrew/bin/opengrep",
    join(home, ".opengrep", "cli", "latest", "opengrep"),
    join(home, ".opengrep", "bin", "opengrep"),
    join(home, ".local", "bin", "opengrep"),
  ];
  for (const c of opengrep) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return { binary: c, engine: "opengrep" };
  }
  for (const c of ["semgrep", "/usr/local/bin/semgrep", "/opt/homebrew/bin/semgrep"]) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return { binary: c, engine: "semgrep" };
  }
  for (const [prog, mod, eng] of [["python3","opengrep","opengrep"],["python3","semgrep","semgrep"]] as const) {
    const r = spawnSync(prog, ["-m", mod, "--version"], { encoding: "utf8" });
    if (r.status === 0) return { binary: `${prog} -m ${mod}`, engine: eng as ScanEngine };
  }
  return null;
}

export function isBearerInstalled(): boolean { return !!findBearer(); }

function findBearer(): string | null {
  for (const c of ["bearer", "/usr/local/bin/bearer", "/opt/homebrew/bin/bearer"]) {
    const r = spawnSync(c, ["version"], { encoding: "utf8" });
    if (r.status === 0) return c;
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
    ruleId: f.check_id, path: f.path,
    line: f.start.line, col: f.start.col,
    severity: f.extra.severity === "ERROR" ? "error" : f.extra.severity === "WARNING" ? "warning" : "info",
    message: f.extra.message, sourceLine: f.extra.lines?.trim(),
    cwe:   toStringArray(f.extra.metadata?.cwe),
    owasp: toStringArray(f.extra.metadata?.owasp),
    references: toStringArray(f.extra.metadata?.references),
    engine,
  };
}

function toStringArray(val: unknown): string[] | undefined {
  if (!val) return undefined;
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") return [val];
  return undefined;
}
