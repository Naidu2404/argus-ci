/**
 * Formats ScanResult into human-readable markdown or compact text.
 * v2.0.0 — grouped by engine, shows AI fix suggestions, per-engine stats.
 */

import type { Issue, ScanResult, Severity, ScanEngine } from "../types.js";

const SEVERITY_EMOJI: Record<Severity, string> = {
  error:   "🔴",
  warning: "🟡",
  info:    "🔵",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  error:   "ERROR",
  warning: "WARNING",
  info:    "INFO",
};

const ENGINE_LABEL: Partial<Record<ScanEngine, string>> = {
  "opengrep":      "Opengrep (security)",
  "semgrep":       "Semgrep (security)",
  "bearer":        "Bearer (data-flow)",
  "oxlint":        "Oxlint (JS/TS quality)",
  "ruff":          "Ruff (Python quality)",
  "golangci-lint": "golangci-lint (Go quality)",
  "rubocop":       "RuboCop (Ruby quality)",
  "pmd":           "PMD (Java quality)",
  "phpstan":       "PHPStan (PHP analysis)",
  "eslint":        "ESLint (project)",
  "tsc":           "TypeScript compiler",
  "prettier":      "Prettier (formatting)",
  "npm-audit":     "npm audit (deps)",
  "pip-audit":     "pip-audit (deps)",
  "bundler-audit": "bundler-audit (deps)",
  "cargo-audit":   "cargo audit (deps)",
  "dependabot":    "Dependabot (deps)",
  "sonar":         "SonarQube/Cloud",
  "ai":            "AI suggestions",
};

// ─── Public API ───────────────────────────────────────────────────────────────

export function toMarkdown(result: ScanResult, context?: string): string {
  if (result.skipped) {
    return `> ⚠️ Scan skipped: ${result.skipReason ?? "unknown reason"}`;
  }

  const { issues, filesScanned, durationMs } = result;
  const errors   = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const infos    = issues.filter((i) => i.severity === "info");

  const lines: string[] = [];
  const header = context ? `## 🔍 argus-ci — ${context}` : `## 🔍 argus-ci scan results`;
  lines.push(header, "");

  // ── Summary ─────────────────────────────────────────────────────────────────
  if (issues.length === 0) {
    lines.push(
      `✅ **No issues found** — ${filesScanned} file${filesScanned !== 1 ? "s" : ""} scanned in ${durationMs}ms`,
      ``,
      `_Engines: ${result.engines.map((e) => ENGINE_LABEL[e] ?? e).join(" · ")}_`
    );
    return lines.join("\n");
  }

  // Summary table
  lines.push(
    `| | Count |`,
    `|---|---|`,
    `| 🔴 Errors   | **${errors.length}**   |`,
    `| 🟡 Warnings | **${warnings.length}** |`,
    `| 🔵 Info     | ${infos.length}    |`,
    `| 📁 Files    | ${filesScanned}    |`,
    `| ⏱ Duration  | ${durationMs}ms    |`,
    ``
  );

  // Per-engine breakdown
  const byEngine = groupByEngine(issues);
  if (Object.keys(byEngine).length > 1) {
    lines.push("**Issues by engine:**");
    for (const [eng, eIssues] of Object.entries(byEngine)) {
      const eErrors = eIssues.filter((i) => i.severity === "error").length;
      const eWarns  = eIssues.filter((i) => i.severity === "warning").length;
      const label   = ENGINE_LABEL[eng as ScanEngine] ?? eng;
      lines.push(`  - ${label}: ${eErrors > 0 ? `${eErrors} errors` : ""}${eErrors > 0 && eWarns > 0 ? ", " : ""}${eWarns > 0 ? `${eWarns} warnings` : ""}`);
    }
    lines.push("");
  }

  // ── Issues by engine > file ──────────────────────────────────────────────────
  for (const [eng, engineIssues] of Object.entries(byEngine)) {
    const label = ENGINE_LABEL[eng as ScanEngine] ?? eng;
    lines.push(`### ${label}`);
    lines.push("");

    const byFile = groupByFile(engineIssues);
    for (const [file, fileIssues] of Object.entries(byFile)) {
      lines.push(`#### \`${file}\``);
      for (const issue of fileIssues) {
        const emoji = SEVERITY_EMOJI[issue.severity];
        const label = SEVERITY_LABEL[issue.severity];
        lines.push(``, `**${emoji} ${label}** — Line ${issue.line}`);
        lines.push(`> ${issue.message}`);
        if (issue.sourceLine) {
          lines.push(`\`\`\`\n${issue.sourceLine}\n\`\`\``);
        }
        lines.push(`_Rule: \`${issue.ruleId}\`_`);
        if (issue.cwe?.length)          lines.push(`_CWE: ${issue.cwe.join(", ")}_`);
        if (issue.owasp?.length)        lines.push(`_OWASP: ${issue.owasp.join(", ")}_`);
        if (issue.fixSuggestion)        lines.push(`\n💡 **Fix:** ${issue.fixSuggestion}`);
        if (issue.references?.length)   lines.push(`_Refs: ${issue.references.slice(0,3).join(", ")}_`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function toCompact(result: ScanResult): string {
  if (result.skipped) return `SKIPPED: ${result.skipReason}`;
  if (result.issues.length === 0) return `CLEAN — ${result.filesScanned} files scanned`;

  const errors = result.issues.filter((i) => i.severity === "error").length;
  const warns  = result.issues.filter((i) => i.severity === "warning").length;
  const engStr = result.engines.map((e) => ENGINE_LABEL[e] ?? e).join(", ");
  return `FOUND ${result.issues.length} issues (${errors} errors, ${warns} warnings) in ${result.filesScanned} files via ${engStr}`;
}

export function toPRComment(result: ScanResult, prTitle: string, prUrl: string): string {
  const lines: string[] = [
    `## 🔍 argus-ci Security & Quality Scan`,
    `> **PR:** [${prTitle}](${prUrl})`,
    ``,
  ];

  if (result.skipped) {
    lines.push(`> ⚠️ Scan skipped: ${result.skipReason}`);
    return lines.join("\n");
  }

  if (result.issues.length === 0) {
    lines.push(`✅ **No issues found** — ${result.filesScanned} files scanned in ${result.durationMs}ms`);
    lines.push(`\n_Engines: ${result.engines.map((e) => ENGINE_LABEL[e] ?? e).join(", ")}_`);
  } else {
    lines.push(toMarkdown(result).replace(/^## 🔍 argus-ci scan results\n/, ""));
  }

  lines.push(`\n---\n_Generated by [argus-ci](https://github.com/argus-ci/argus-ci) · ${new Date().toISOString()}_`);
  return lines.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function groupByFile(issues: Issue[]): Record<string, Issue[]> {
  const out: Record<string, Issue[]> = {};
  for (const issue of issues) {
    (out[issue.path] ??= []).push(issue);
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => a.line - b.line);
  }
  return out;
}

function groupByEngine(issues: Issue[]): Record<string, Issue[]> {
  const out: Record<string, Issue[]> = {};
  for (const issue of issues) {
    const eng = issue.engine ?? "unknown";
    (out[eng] ??= []).push(issue);
  }
  // Sort engines by severity (most errors first)
  return Object.fromEntries(
    Object.entries(out).sort(([, a], [, b]) => {
      const aE = a.filter((i) => i.severity === "error").length;
      const bE = b.filter((i) => i.severity === "error").length;
      return bE - aE;
    })
  );
}
