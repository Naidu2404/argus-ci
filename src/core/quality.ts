/**
 * Pluggable code-quality engine.
 *
 * Runs the right linter for the detected stack:
 *   JS/TS  → Oxlint        (500+ rules, Rust-speed, zero config)
 *   Python → Ruff          (800+ rules, Rust-speed, drop-in Flake8+isort)
 *   Go     → golangci-lint (aggregates 50+ Go linters)
 *   Ruby   → RuboCop       (community standard Ruby linter)
 *   Java   → PMD           (static analysis, complexity, duplicates)
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
      case "pmd":           return runPMD(files, cwd, binary, t0);
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

// ─── PMD (Java) ───────────────────────────────────────────────────────────────

function runPMD(files: string[], cwd: string, binary: string, t0: number): ScanResult {
  const result = spawnSync(
    binary,
    ["check", "--format", "json", "--rulesets", "rulesets/java/quickstart.xml",
     "--dir", files.join(",")],
    { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 60_000 }
  );

  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return clean(files.length, t0, "pmd");

  let raw: PMDOutput;
  try {
    raw = JSON.parse(stdout) as PMDOutput;
  } catch {
    return skip("Failed to parse PMD output", t0);
  }

  const issues: Issue[] = (raw.violations ?? []).map((v) => ({
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

interface PMDOutput {
  violations: Array<{
    filename:    string;
    beginline:   number;
    begincolumn: number;
    rule:        string;
    ruleset:     string;
    description: string;
    priority:    number;
  }> | null;
}
