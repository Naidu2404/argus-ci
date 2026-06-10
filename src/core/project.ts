/**
 * Pass 4 — Project-level checks.
 *
 * Unlike Pass 3 (generic linters), this pass uses the REPO'S OWN config:
 *   • ESLint   — runs with .eslintrc / eslint.config.js found in the project
 *   • tsc      — runs tsc --noEmit with the project's tsconfig.json
 *   • Prettier — checks formatting against the project's .prettierrc
 *
 * Every check skips gracefully if the tool or config is absent.
 */

import { spawnSync, execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, relative } from "path";
import type { Issue, ScanResult } from "../types.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runProjectChecks(
  files: string[],
  cwd:   string,
  t0:    number,
  isRepoScan = false
): Promise<ScanResult> {
  const results: ScanResult[] = [];

  const eslint  = runEslint(files, cwd, t0, isRepoScan);
  const tsc     = runTsc(cwd, t0);
  const prettier = runPrettier(files, cwd, t0, isRepoScan);

  results.push(eslint, tsc, prettier);

  return mergeProjectResults(results, files.length, t0);
}

// ─── ESLint ───────────────────────────────────────────────────────────────────

function runEslint(files: string[], cwd: string, t0: number, isRepoScan = false): ScanResult {
  const bin = findBin("eslint", cwd);
  if (!bin) return skip("ESLint not found (run npm install)", t0, []);

  // Check an ESLint config file exists
  const configs = [
    "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
    ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml", ".eslintrc",
  ];
  const hasConfig = configs.some((c) => existsSync(join(cwd, c)));
  if (!hasConfig) return skip("No ESLint config found in project", t0, []);

  // Filter to files ESLint can handle
  const eligible = isRepoScan
    ? []  // use directory mode
    : files.filter((f) => /\.(js|mjs|cjs|jsx|ts|tsx|vue|svelte)$/.test(f));

  if (!isRepoScan && eligible.length === 0) {
    return skip("No JS/TS files to lint", t0, []);
  }

  const targets = isRepoScan ? ["src", "."].filter((d) => existsSync(join(cwd, d))).slice(0, 1) : eligible;

  let stdout = "";
  try {
    const r = spawnSync(bin, ["--format", "json", "--no-error-on-unmatched-pattern", ...targets], {
      cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    });
    stdout = r.stdout ?? "";
  } catch {
    return skip("ESLint execution failed", t0, []);
  }

  if (!stdout.trim()) return clean(files.length, t0, "eslint");

  let raw: ESLintFileResult[];
  try { raw = JSON.parse(stdout) as ESLintFileResult[]; }
  catch { return skip("Failed to parse ESLint output", t0, []); }

  const issues: Issue[] = [];
  for (const fileResult of raw) {
    const relPath = fileResult.filePath.startsWith(cwd)
      ? fileResult.filePath.slice(cwd.length + 1)
      : fileResult.filePath;

    for (const msg of fileResult.messages) {
      if (!msg.ruleId && msg.fatal) continue; // parse errors, skip
      issues.push({
        ruleId:   `eslint/${msg.ruleId ?? "parse-error"}`,
        path:     relPath,
        line:     msg.line ?? 1,
        col:      msg.column ?? 1,
        severity: msg.severity === 2 ? "error" : "warning",
        message:  msg.message,
        engine:   "eslint",
      });
    }
  }

  return {
    issues, skipped: false,
    filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets: ["eslint/project-config"], engines: ["eslint"],
  };
}

// ─── TypeScript (tsc --noEmit) ────────────────────────────────────────────────

function runTsc(cwd: string, t0: number): ScanResult {
  // Only run if tsconfig.json exists
  if (!existsSync(join(cwd, "tsconfig.json"))) {
    return skip("No tsconfig.json found", t0, []);
  }

  const bin = findBin("tsc", cwd);
  if (!bin) return skip("TypeScript not installed (run npm install)", t0, []);

  const r = spawnSync(bin, ["--noEmit", "--pretty", "false"], {
    cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 60_000,
  });

  const output = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  if (!output || r.status === 0) return clean(0, t0, "tsc");

  // Parse tsc output: "path/to/file.ts(line,col): error TS1234: message"
  const issues: Issue[] = [];
  const lineRe = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

  for (const line of output.split("\n")) {
    const m = line.match(lineRe);
    if (!m) continue;
    const [, filePath, lineStr, colStr, sev, code, msg] = m;
    const relPath = filePath!.startsWith(cwd) ? filePath!.slice(cwd.length + 1) : filePath!;
    issues.push({
      ruleId:   `tsc/${code}`,
      path:     relPath!,
      line:     parseInt(lineStr!, 10),
      col:      parseInt(colStr!, 10),
      severity: sev === "error" ? "error" : "warning",
      message:  msg!,
      engine:   "tsc",
    });
  }

  return {
    issues, skipped: false,
    filesScanned: 0, durationMs: Date.now() - t0,
    rulesets: ["tsc/strict"], engines: ["tsc"],
  };
}

// ─── Prettier ─────────────────────────────────────────────────────────────────

function runPrettier(files: string[], cwd: string, t0: number, isRepoScan = false): ScanResult {
  const bin = findBin("prettier", cwd);
  if (!bin) return skip("Prettier not found (run npm install)", t0, []);

  // Check prettier config exists
  const configs = [
    ".prettierrc", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs",
    ".prettierrc.json", ".prettierrc.json5", ".prettierrc.yml", ".prettierrc.yaml",
    "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
  ];
  // Also check if "prettier" key exists in package.json
  let hasConfig = configs.some((c) => existsSync(join(cwd, c)));
  if (!hasConfig) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
      hasConfig = "prettier" in pkg;
    } catch { /* ignore */ }
  }
  if (!hasConfig) return skip("No Prettier config found in project", t0, []);

  const eligible = isRepoScan
    ? []
    : files.filter((f) => /\.(js|mjs|cjs|jsx|ts|tsx|vue|svelte|json|css|scss|html|md)$/.test(f));

  if (!isRepoScan && eligible.length === 0) return skip("No Prettier-compatible files", t0, []);

  const targets = isRepoScan
    ? ["src", "."].filter((d) => existsSync(join(cwd, d))).slice(0, 1)
    : eligible;

  const r = spawnSync(bin, ["--check", "--no-error-on-unmatched-pattern", ...targets], {
    cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
  });

  if (r.status === 0) return clean(files.length, t0, "prettier");

  // Prettier exits 1 when files are unformatted; output lists the files
  const issues: Issue[] = [];
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Checking") || trimmed.startsWith("Code style")) continue;
    if (trimmed.includes("prettier") && !trimmed.includes("/")) continue;
    // Lines like "[warn] src/foo.ts"
    const filePath = trimmed.replace(/^\[warn\]\s*/, "").trim();
    if (!filePath || filePath.includes(" ")) continue;
    const relPath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
    issues.push({
      ruleId:   "prettier/format",
      path:     relPath,
      line:     1, col: 1,
      severity: "warning",
      message:  "File is not formatted — run Prettier to fix",
      engine:   "prettier",
    });
  }

  return {
    issues, skipped: false,
    filesScanned: files.length, durationMs: Date.now() - t0,
    rulesets: ["prettier/project-config"], engines: ["prettier"],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Find a local node_modules/.bin binary, falling back to system PATH */
function findBin(name: string, cwd: string): string | null {
  const local = join(cwd, "node_modules", ".bin", name);
  if (existsSync(local)) return local;

  const r = spawnSync("which", [name], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();

  return null;
}

function mergeProjectResults(results: ScanResult[], filesScanned: number, t0: number): ScanResult {
  const allIssues: Issue[] = [];
  const allEngines: ScanResult["engines"] = [];
  const allRulesets: string[] = [];

  for (const r of results) {
    if (!r.skipped) {
      allIssues.push(...r.issues);
      allEngines.push(...r.engines);
      allRulesets.push(...r.rulesets);
    }
  }

  const ranAny = results.some((r) => !r.skipped);
  if (!ranAny) {
    return {
      issues: [], skipped: true,
      skipReason: "No project checks ran (ESLint/tsc/Prettier not configured in this repo)",
      filesScanned, durationMs: Date.now() - t0,
      rulesets: [], engines: [],
    };
  }

  return {
    issues: allIssues, skipped: false,
    filesScanned, durationMs: Date.now() - t0,
    rulesets: [...new Set(allRulesets)],
    engines:  [...new Set(allEngines)],
  };
}

function skip(reason: string, t0: number, _engines: string[]): ScanResult {
  return {
    issues: [], skipped: true, skipReason: reason,
    filesScanned: 0, durationMs: Date.now() - t0,
    rulesets: [], engines: [],
  };
}

function clean(filesScanned: number, t0: number, engine: string): ScanResult {
  return {
    issues: [], skipped: false,
    filesScanned, durationMs: Date.now() - t0,
    rulesets: [`${engine}/project-config`], engines: [engine as ScanResult["engines"][number]],
  };
}

// ─── Raw types ────────────────────────────────────────────────────────────────

interface ESLintFileResult {
  filePath: string;
  messages: Array<{
    ruleId?:   string | null;
    severity:  number;
    message:   string;
    line:      number;
    column:    number;
    fatal?:    boolean;
  }>;
}
