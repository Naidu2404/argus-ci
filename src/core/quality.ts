/**
 * Pluggable code-quality engine.
 *
 * Runs the right linter for the detected stack:
 *   JS/TS  → Oxlint   (500+ rules, Rust-speed, zero config)
 *   Python → Ruff     (800+ rules, Rust-speed, drop-in Flake8+isort)
 *   Go     → golangci-lint  (aggregates 50+ Go linters)
 *   Ruby   → RuboCop  (community standard Ruby linter)
 *   Java   → PMD      (static analysis, complexity, duplicates)
 *
 * Each engine is optional — if not installed, quality scan is skipped
 * gracefully without blocking the security scan.
 */

import { spawnSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import type { Issue, QualityEngine, ScanResult } from "../types.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export function isQualityEngineInstalled(engine: QualityEngine): boolean {
  return !!findEngine(engine);
}

export async function runQualityScan(
  files:  string[],
  cwd:    string,
  engine: QualityEngine,
  t0:     number
): Promise<ScanResult> {
  const binary = findEngine(engine);
  if (!binary) {
    return skip(`${engine} not installed`, t0);
  }

  try {
    switch (engine) {
      case "oxlint":       return runOxlint(files, cwd, binary, t0);
      case "ruff":         return runRuff(files, cwd, binary, t0);
      case "golangci-lint":return runGolangci(files, cwd, binary, t0);
      case "rubocop":      return runRubocop(files, cwd, binary, t0);
      case "pmd":          return runPMD(files, cwd, binary, t0);
      default:             return skip(`Unknown quality engine: ${engine}`, t0);
    }
  } catch (err) {
    return skip(`${engine} error: ${String(err).slice(0, 200)}`, t0);
  }
}

// ─── Oxlint (JS / TS) ────────────────────────────────────────────────────────

function runOxlint(files: string[], cwd: string, binary: string, t0: number): ScanResult {
  // oxlint --format json <files>
  const result = spawnSync(binary, ["--format", "json", ...files], {
    cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024,
  });

  // oxlint exits 1 when issues found — that's fine
  const stdout = result.stdout ?? "";
  if (!stdout.trim()) return clean(files.length, t0, "oxlint");

  let raw: OxlintOutput;
  try {
    raw = JSON.parse(stdout) as OxlintOutput;
  } catch {
    return skip("Failed to parse oxlint output", t0);
  }

  const issues: Issue[] = raw.diagnostics.map((d) => ({
    ruleId:     d.rule_id ?? "oxlint/unknown",
    path:       d.filename,
    line:       d.labels[0]?.span?.start?.line ?? 1,
    col:        d.labels[0]?.span?.start?.column ?? 1,
    severity:   mapOxlintSeverity(d.severity),
    message:    d.message,
    sourceLine: d.labels[0]?.message,
    engine:     "oxlint",
  }));

  return {
    issues, skipped: false,
    filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets: ["oxlint/recommended"], engines: ["oxlint"],
  };
}

// ─── Ruff (Python) ───────────────────────────────────────────────────────────

function runRuff(files: string[], cwd: string, binary: string, t0: number): ScanResult {
  // ruff check --output-format json <files>
  const result = spawnSync(binary, ["check", "--output-format", "json", ...files], {
    cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024,
  });

  const stdout = result.stdout ?? "";
  if (!stdout.trim()) return clean(files.length, t0, "ruff");

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
    severity: f.fix ? "warning" : "warning", // ruff doesn't have error/info — warnings only
    message:  f.message,
    engine:   "ruff",
  }));

  return {
    issues, skipped: false,
    filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets: ["ruff/all"], engines: ["ruff"],
  };
}

// ─── golangci-lint (Go) ───────────────────────────────────────────────────────

function runGolangci(files: string[], cwd: string, binary: string, t0: number): ScanResult {
  // golangci-lint run --out-format json ./...
  // Files are scoped by running from the cwd (package level)
  const result = spawnSync(binary, ["run", "--out-format", "json", "--timeout", "60s", "./..."], {
    cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 90_000,
  });

  const stdout = result.stdout ?? "";
  if (!stdout.trim()) return clean(files.length, t0, "golangci-lint");

  let raw: GolangciOutput;
  try {
    raw = JSON.parse(stdout) as GolangciOutput;
  } catch {
    return skip("Failed to parse golangci-lint output", t0);
  }

  // Filter to only files we were asked about
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
  // rubocop --format json <files>
  const result = spawnSync(binary, ["--format", "json", ...files], {
    cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024,
  });

  const stdout = result.stdout ?? "";
  if (!stdout.trim()) return clean(files.length, t0, "rubocop");

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
  // pmd check --format json --dir <files joined by comma>
  const result = spawnSync(
    binary,
    ["check", "--format", "json", "--rulesets", "rulesets/java/quickstart.xml",
     "--dir", files.join(",")],
    { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 60_000 }
  );

  const stdout = result.stdout ?? "";
  if (!stdout.trim()) return clean(files.length, t0, "pmd");

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
  const versionFlag = engine === "golangci-lint" ? ["--version"] :
                      engine === "pmd"            ? ["--version"] :
                      engine === "rubocop"        ? ["--version"] :
                      ["--version"];

  for (const cmd of candidates) {
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
        // npx fallback — always works but slow for repeated calls
        // we avoid this as a detection method
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
  if (s === "error")   return "error";
  if (s === "warning") return "warning";
  return "info";
}

function mapRubocopSeverity(s: string): Issue["severity"] {
  if (s === "error" || s === "fatal")  return "error";
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

// ─── Raw output types ────────────────────────────────────────────────────────

interface OxlintOutput {
  diagnostics: Array<{
    rule_id?:  string;
    severity:  string;
    message:   string;
    filename:  string;
    labels: Array<{
      message?: string;
      span?: { start?: { line: number; column: number } };
    }>;
  }>;
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
