/**
 * Pluggable code-quality engine.
 *
 * Runs the right linter for the detected stack:
 *   JS/TS  → Oxlint        (500+ rules, Rust-speed, zero config)
 *   Python → Ruff          (800+ rules, Rust-speed, drop-in Flake8+isort)
 *   Go     → golangci-lint (aggregates 50+ Go linters)
 *   Ruby   → RuboCop       (community standard Ruby linter)
 *   Java   → PMD           (static analysis, complexity, duplicates)
 *   PHP    → PHPStan       (static analysis: undefined vars, wrong types, dead code)
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Issue, QualityEngine, ScanResult } from "../types.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export function isQualityEngineInstalled(engine: QualityEngine): boolean {
  return !!findEngine(engine);
}

export async function runQualityScan(
  files:       string[],
  cwd:         string,
  engine:      QualityEngine,
  t0:          number,
  isRepoScan = false   // when true, scan cwd directory instead of listing every file
): Promise<ScanResult> {
  const binary = findEngine(engine);
  if (!binary) {
    return skip(`${engine} not installed`, t0);
  }

  try {
    switch (engine) {
      case "oxlint":        return runOxlint(files, cwd, binary, t0, isRepoScan);
      case "ruff":          return runRuff(files, cwd, binary, t0, isRepoScan);
      case "golangci-lint": return runGolangci(files, cwd, binary, t0);
      case "rubocop":       return runRubocop(files, cwd, binary, t0);
      case "pmd":           return runPMD(files, cwd, binary, t0, isRepoScan);
      case "phpstan":       return runPhpstan(files, cwd, binary, t0, isRepoScan);
      default:              return skip(`Unknown quality engine: ${engine}`, t0);
    }
  } catch (err) {
    return skip(`${engine} error: ${String(err).slice(0, 200)}`, t0);
  }
}

// ─── Oxlint (JS / TS / Vue / React) ──────────────────────────────────────────

function runOxlint(files: string[], cwd: string, binary: string, t0: number, isRepoScan = false): ScanResult {
  const pluginFlags = detectOxlintPlugins(cwd);

  // For repo scans or large file sets (> 50 files): scan the directory directly.
  // This avoids "Argument list too long" OS errors and is significantly faster.
  // Oxlint respects .gitignore and skips node_modules automatically.
  const targets = (isRepoScan || files.length > 50) ? [cwd] : files;

  const args = [
    "--format", "json",
    ...pluginFlags,
    "--",
    ...targets,
  ];

  const result = spawnSync(binary, args, {
    cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024,
  });

  // Oxlint exits 1 when issues found — that's expected
  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return clean(files.length, t0, "oxlint");

  let raw: OxlintOutput;
  try {
    raw = JSON.parse(stdout) as OxlintOutput;
  } catch {
    // Oxlint sometimes emits partial JSON when it hits a parse error in a file
    // Try to extract the diagnostics array manually
    const match = stdout.match(/"diagnostics"\s*:\s*(\[[\s\S]*?\])/);
    if (match) {
      try {
        const diags = JSON.parse(match[1]!) as OxlintDiagnostic[];
        raw = { diagnostics: diags };
      } catch {
        return skip("Failed to parse oxlint output", t0);
      }
    } else {
      return skip("Failed to parse oxlint output", t0);
    }
  }

  const issues: Issue[] = (raw.diagnostics ?? []).map((d) => {
    // Actual field from oxlint JSON: "code" (e.g. "eslint(no-eval)")
    // Position: labels[0].span.line / labels[0].span.column  (1-based)
    const span = d.labels[0]?.span;
    return {
      ruleId:     d.code ?? "oxlint/unknown",
      path:       d.filename,
      line:       span?.line ?? 1,
      col:        span?.column ?? 1,
      severity:   mapOxlintSeverity(d.severity),
      message:    d.message + (d.help ? `\n  💡 ${d.help}` : ""),
      sourceLine: d.labels[0]?.label,
      engine:     "oxlint",
    };
  });

  const ruleset = pluginFlags.length
    ? `oxlint/recommended+${pluginFlags.filter((f) => f.endsWith("-plugin")).map((f) => f.replace("--", "").replace("-plugin", "")).join("+")}`
    : "oxlint/recommended";

  return {
    issues, skipped: false,
    filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets: [ruleset], engines: ["oxlint"],
  };
}

/** Auto-detect which Oxlint plugins to enable based on package.json */
function detectOxlintPlugins(cwd: string): string[] {
  const flags: string[] = [];
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return flags;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  } catch { return flags; }

  const allDeps = {
    ...((pkg.dependencies   as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  };

  // React (also enables react-perf for performance issues)
  if (allDeps["react"] || allDeps["react-dom"]) {
    flags.push("--react-plugin");
    flags.push("--react-perf-plugin");
    flags.push("--jsx-a11y-plugin");
  }

  // Vue
  if (allDeps["vue"] || allDeps["@vue/core"] || allDeps["@vue/cli-service"]) {
    flags.push("--vue-plugin");
  }

  // Next.js
  if (allDeps["next"]) {
    flags.push("--nextjs-plugin");
  }

  // Jest
  if (allDeps["jest"] || allDeps["@jest/core"] || allDeps["vitest"]) {
    flags.push(allDeps["vitest"] ? "--vitest-plugin" : "--jest-plugin");
  }

  // Promises
  if (Object.keys(allDeps).some((d) => d.includes("promise") || d.includes("async"))) {
    flags.push("--promise-plugin");
  }

  // Node.js
  const serverDeps = ["express", "fastify", "koa", "@nestjs/core", "hapi"];
  if (serverDeps.some((d) => d in allDeps)) {
    flags.push("--node-plugin");
  }

  // Always enable import plugin (catches missing imports, circular deps)
  flags.push("--import-plugin");

  // Always enable promise plugin (catches unhandled promises)
  flags.push("--promise-plugin");

  return [...new Set(flags)]; // dedupe
}

// ─── Ruff (Python) ───────────────────────────────────────────────────────────

function runRuff(files: string[], cwd: string, binary: string, t0: number, isRepoScan = false): ScanResult {
  const targets = (isRepoScan || files.length > 50) ? [cwd] : files;
  const result = spawnSync(
    binary,
    ["check", "--output-format", "json", "--select", "ALL",
     "--ignore", "D,ANN,ERA,FIX,TD",
     ...targets],
    { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
  );

  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return clean(files.length, t0, "ruff");

  let raw: RuffFinding[];
  try {
    raw = JSON.parse(stdout) as RuffFinding[];
  } catch {
    return skip("Failed to parse ruff output", t0);
  }

  const issues: Issue[] = raw.map((f) => ({
    ruleId:   `ruff/${f.code}`,
    path:     f.filename,
    line:     f.location.row,
    col:      f.location.column,
    severity: mapRuffSeverity(f.code),
    message:  f.message,
    engine:   "ruff",
  }));

  return {
    issues, skipped: false,
    filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets: ["ruff/ALL"], engines: ["ruff"],
  };
}

// ─── golangci-lint (Go) ───────────────────────────────────────────────────────

function runGolangci(files: string[], cwd: string, binary: string, t0: number): ScanResult {
  const result = spawnSync(binary, ["run", "--out-format", "json", "--timeout", "60s", "./..."], {
    cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 90_000,
  });

  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return clean(files.length, t0, "golangci-lint");

  let raw: GolangciOutput;
  try {
    raw = JSON.parse(stdout) as GolangciOutput;
  } catch {
    return skip("Failed to parse golangci-lint output", t0);
  }

  const fileSet = new Set(files.map((f) => (f.startsWith("/") ? f : join(cwd, f))));

  const issues: Issue[] = (raw.Issues ?? [])
    .filter((i) => {
      const abs = i.Pos.Filename.startsWith("/") ? i.Pos.Filename : join(cwd, i.Pos.Filename);
      return fileSet.has(abs) || files.some((f) => abs.endsWith(f) || f.endsWith(i.Pos.Filename));
    })
    .map((i) => ({
      ruleId:   `golangci/${i.FromLinter}`,
      path:     i.Pos.Filename,
      line:     i.Pos.Line,
      col:      i.Pos.Column,
      severity: "warning" as const,
      message:  i.Text,
      engine:   "golangci-lint" as const,
    }));

  return {
    issues, skipped: false,
    filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets: ["golangci-lint/default"], engines: ["golangci-lint"],
  };
}

// ─── RuboCop (Ruby) ───────────────────────────────────────────────────────────

function runRubocop(files: string[], cwd: string, binary: string, t0: number): ScanResult {
  const result = spawnSync(binary, ["--format", "json", ...files], {
    cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024,
  });

  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return clean(files.length, t0, "rubocop");

  let raw: RubocopOutput;
  try {
    raw = JSON.parse(stdout) as RubocopOutput;
  } catch {
    return skip("Failed to parse rubocop output", t0);
  }

  const issues: Issue[] = raw.files.flatMap((f) =>
    f.offenses.map((o) => ({
      ruleId:   `rubocop/${o.cop_name}`,
      path:     f.path,
      line:     o.location.start_line,
      col:      o.location.start_column,
      severity: mapRubocopSeverity(o.severity),
      message:  o.message,
      engine:   "rubocop" as const,
    }))
  );

  return {
    issues, skipped: false,
    filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets: ["rubocop/default"], engines: ["rubocop"],
  };
}

// ─── PHPStan (PHP) ───────────────────────────────────────────────────────────
//
// Requires phpstan to be installed (composer global require phpstan/phpstan
// or curl download of the .phar). Level 3 is balanced: catches undefined
// variables, wrong types, dead code — without overwhelming noise.

function runPhpstan(files: string[], cwd: string, binary: string, t0: number, isRepoScan = false): ScanResult {
  // phpstan works best with a directory; for repo scans use cwd, otherwise use
  // the unique set of directories containing the target files.
  const targets = isRepoScan
    ? [cwd]
    : [...new Set(files.map((f) => {
        const abs = f.startsWith("/") ? f : join(cwd, f);
        // If it's a file, scan the file directly; phpstan accepts file paths too
        return abs;
      }))];

  const args = [
    "analyse",
    "--error-format=json",
    "--no-progress",
    "--level",       "3",     // balanced level (0=loose … 9=strict)
    "--memory-limit", "512M",
    ...targets,
  ];

  const result = spawnSync(binary, args, {
    cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 120_000,
  });

  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return clean(files.length, t0, "phpstan");

  let raw: PhpstanOutput;
  try {
    raw = JSON.parse(stdout) as PhpstanOutput;
  } catch {
    return skip("Failed to parse phpstan output", t0);
  }

  const issues: Issue[] = [];
  for (const [filePath, fileData] of Object.entries(raw.files ?? {})) {
    for (const msg of fileData.messages ?? []) {
      const relPath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
      issues.push({
        ruleId:   `phpstan/${msg.identifier ?? "error"}`,
        path:     relPath,
        line:     msg.line,
        col:      1,
        severity: "warning",    // phpstan doesn't expose severity levels
        message:  msg.message,
        engine:   "phpstan",
      });
    }
  }

  return {
    issues, skipped: false,
    filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets: ["phpstan/level3"], engines: ["phpstan"],
  };
}

// ─── PMD (Java) ───────────────────────────────────────────────────────────────
//
// PMD always scans the project directory (same pattern as golangci-lint ./...).
// Passing individual files via --dir doesn't work reliably across PMD versions.
//
// JSON format changed between PMD 6 and PMD 7:
//   PMD 6: { "violations": [{ "filename": ..., ... }] }
//   PMD 7: { "files": [{ "filename": ..., "violations": [{ ... }] }] }
// We handle both.

function runPMD(files: string[], cwd: string, binary: string, t0: number, isRepoScan = false): ScanResult {
  const result = spawnSync(
    binary,
    [
      "check",
      "--format",       "json",
      "--rulesets",     "rulesets/java/quickstart.xml",
      "--dir",          cwd,
      "--no-cache",
    ],
    { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 120_000 }
  );

  // PMD exits 4 when violations found — treat as success
  const stdout = (result.stdout ?? "").trim();
  if (!stdout) {
    // If PMD produced no output and stderr mentions unknown ruleset, try category-based
    const stderr = (result.stderr ?? "").toLowerCase();
    if (stderr.includes("ruleset") || stderr.includes("could not find")) {
      return runPMDWithCategoryRulesets(files, cwd, binary, t0);
    }
    return clean(files.length, t0, "pmd");
  }

  let raw: PMDOutputV6 | PMDOutputV7;
  try {
    raw = JSON.parse(stdout) as PMDOutputV6 | PMDOutputV7;
  } catch {
    return skip("Failed to parse PMD output", t0);
  }

  // Normalise both PMD 6 and PMD 7 formats into a flat violation list
  let violations: PMDViolation[];
  if ("files" in raw && Array.isArray(raw.files)) {
    // PMD 7: violations nested per file
    violations = raw.files.flatMap((f) =>
      (f.violations ?? []).map((v) => ({ ...v, filename: f.filename }))
    );
  } else if ("violations" in raw && Array.isArray(raw.violations)) {
    // PMD 6: flat violations array with filename on each
    violations = raw.violations;
  } else {
    violations = [];
  }

  // For targeted file scans, filter to only the requested files
  const fileSet = new Set(files.map((f) => (f.startsWith("/") ? f : join(cwd, f))));
  const filtered = isRepoScan
    ? violations
    : violations.filter((v) => {
        const abs = v.filename.startsWith("/") ? v.filename : join(cwd, v.filename);
        return fileSet.has(abs) || files.some((f) => abs.endsWith(f) || f.endsWith(v.filename));
      });

  const issues: Issue[] = filtered.map((v) => ({
    ruleId:   `pmd/${v.ruleset}/${v.rule}`,
    path:     v.filename,
    line:     v.beginline,
    col:      v.begincolumn,
    severity: mapPMDPriority(v.priority),
    message:  v.description,
    engine:   "pmd" as const,
  }));

  return {
    issues, skipped: false,
    filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets: ["pmd/quickstart"], engines: ["pmd"],
  };
}

/** Fallback when quickstart.xml isn't found — use PMD 7 category rulesets */
function runPMDWithCategoryRulesets(files: string[], cwd: string, binary: string, t0: number): ScanResult {
  const result = spawnSync(
    binary,
    [
      "check",
      "--format",       "json",
      "--rulesets",     "category/java/bestpractices.xml,category/java/errorprone.xml,category/java/codestyle.xml",
      "--dir",          cwd,
      "--no-cache",
    ],
    { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 120_000 }
  );

  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return clean(files.length, t0, "pmd");

  let raw: PMDOutputV7;
  try {
    raw = JSON.parse(stdout) as PMDOutputV7;
  } catch {
    return skip("Failed to parse PMD output", t0);
  }

  const violations = (raw.files ?? []).flatMap((f) =>
    (f.violations ?? []).map((v) => ({ ...v, filename: f.filename }))
  );

  const issues: Issue[] = violations.map((v) => ({
    ruleId:   `pmd/${v.ruleset}/${v.rule}`,
    path:     v.filename,
    line:     v.beginline,
    col:      v.begincolumn,
    severity: mapPMDPriority(v.priority),
    message:  v.description,
    engine:   "pmd" as const,
  }));

  return {
    issues, skipped: false,
    filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets: ["pmd/category-java"], engines: ["pmd"],
  };
}

// ─── Engine discovery ────────────────────────────────────────────────────────

function findEngine(engine: QualityEngine): string | null {
  const candidates = engineCandidates(engine);
  const versionFlag = ["--version"];

  for (const cmd of candidates) {
    if (!cmd) continue;
    const r = spawnSync(cmd, versionFlag, { encoding: "utf8" });
    if (r.status === 0) return cmd;
  }
  return null;
}

function engineCandidates(engine: QualityEngine): string[] {
  const home = homedir();
  switch (engine) {
    case "oxlint":
      return [
        "oxlint",
        "/usr/local/bin/oxlint",
        "/opt/homebrew/bin/oxlint",
        join(home, ".local", "bin", "oxlint"),
        join(home, ".npm-global", "bin", "oxlint"),
        join(home, "node_modules", ".bin", "oxlint"),
      ];
    case "ruff":
      return [
        "ruff",
        "/usr/local/bin/ruff",
        "/opt/homebrew/bin/ruff",
        join(home, ".local", "bin", "ruff"),
        join(home, ".cargo", "bin", "ruff"),
      ];
    case "golangci-lint":
      return [
        "golangci-lint",
        "/usr/local/bin/golangci-lint",
        "/opt/homebrew/bin/golangci-lint",
        join(home, "go", "bin", "golangci-lint"),
        join(home, ".local", "bin", "golangci-lint"),
      ];
    case "rubocop":
      return ["rubocop", "/usr/local/bin/rubocop", join(home, ".rbenv", "shims", "rubocop")];
    case "pmd":
      return ["pmd", "/usr/local/bin/pmd", "/opt/homebrew/bin/pmd"];
    case "phpstan":
      return [
        "phpstan",
        "/usr/local/bin/phpstan",
        "/opt/homebrew/bin/phpstan",
        join(home, ".composer", "vendor", "bin", "phpstan"),
        join(home, ".config", "composer", "vendor", "bin", "phpstan"),
        join(home, ".local", "bin", "phpstan"),
        "/usr/local/lib/phpstan.phar",
      ];
    default:
      return [];
  }
}

// ─── Severity mappers ────────────────────────────────────────────────────────

function mapOxlintSeverity(s: string): Issue["severity"] {
  const lower = s.toLowerCase();
  if (lower === "error")   return "error";
  if (lower === "warning") return "warning";
  return "info";
}

function mapRuffSeverity(code: string): Issue["severity"] {
  // E = error, W = warning, everything else = info
  if (code.startsWith("E")) return "error";
  if (code.startsWith("W")) return "warning";
  return "warning"; // most Ruff codes are quality warnings
}

function mapRubocopSeverity(s: string): Issue["severity"] {
  if (s === "error" || s === "fatal")                             return "error";
  if (s === "warning" || s === "convention" || s === "refactor") return "warning";
  return "info";
}

function mapPMDPriority(p: number): Issue["severity"] {
  if (p <= 2) return "error";
  if (p <= 3) return "warning";
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

function clean(filesScanned: number, t0: number, engine: QualityEngine): ScanResult {
  return {
    issues: [], skipped: false,
    filesScanned, durationMs: Date.now() - t0,
    rulesets: [`${engine}/recommended`], engines: [engine],
  };
}

// ─── Raw output types ─────────────────────────────────────────────────────────

interface OxlintDiagnostic {
  code?:     string;        // e.g. "eslint(no-eval)"  — NOT rule_id
  severity:  string;        // "warning" | "error"
  message:   string;
  help?:     string;        // human-readable fix hint
  filename:  string;
  labels: Array<{
    label?:  string;        // optional label text shown inline
    span: {
      line:   number;       // 1-based line   — NOT span.start.line
      column: number;       // 1-based column — NOT span.start.column
      offset: number;
      length: number;
    };
  }>;
}

interface OxlintOutput {
  diagnostics: OxlintDiagnostic[];
}

interface RuffFinding {
  code:     string;
  message:  string;
  filename: string;
  fix?:     unknown;
  location: { row: number; column: number };
}

interface GolangciOutput {
  Issues: Array<{
    Text:       string;
    FromLinter: string;
    Pos: { Filename: string; Line: number; Column: number };
  }> | null;
}

interface RubocopOutput {
  files: Array<{
    path:     string;
    offenses: Array<{
      severity:  string;
      message:   string;
      cop_name:  string;
      location:  { start_line: number; start_column: number };
    }>;
  }>;
}

// PMD violation shape (shared between v6 and v7)
interface PMDViolation {
  filename:    string;
  beginline:   number;
  begincolumn: number;
  rule:        string;
  ruleset:     string;
  description: string;
  priority:    number;
}

// PMD 6 — flat violations array
interface PMDOutputV6 {
  violations: PMDViolation[] | null;
}

// PMD 7 — violations nested under each file
interface PMDOutputV7 {
  pmdVersion?: string;
  files: Array<{
    filename:   string;
    violations: Omit<PMDViolation, "filename">[];
  }> | null;
  processingErrors?: unknown[];
  configurationErrors?: unknown[];
}

// PHPStan JSON output (--error-format=json)
interface PhpstanOutput {
  totals?: { errors: number; file_errors: number };
  files: Record<string, {
    errors:   number;
    messages: Array<{
      message:     string;
      line:        number;
      ignorable?:  boolean;
      identifier?: string;   // e.g. "function.notFound"
    }>;
  }> | null;
  errors?: string[];
}
