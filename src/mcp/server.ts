/**
 * argus-ci — MCP Server v2.0.0
 *
 * Tools exposed to Cursor / Claude Code / any MCP client:
 *
 *   scan_repo         — full repo scan (6 passes: security + quality + deps + sonar)
 *   scan_files        — scan specific files (post code-generation)
 *   scan_staged       — scan git staged files (pre-commit check)
 *   scan_branch       — scan changed files on a branch vs base
 *   scan_pr           — scan a GitHub PR by URL
 *   find_trace_code   — find console.log / debugger / TODOs in source files
 *   remove_trace_code — auto-remove safe trace items (console/debugger)
 *   check_setup       — show which tools/tokens are configured
 *
 * Add to Cursor: Settings → MCP → add entry:
 *   { "command": "npx", "args": ["argus-ci"] }
 *
 * Add to Claude Code (~/.claude/settings.json):
 *   { "mcpServers": { "argus-ci": { "command": "npx", "args": ["argus-ci"] } } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { scanFiles, scanStaged, scanBranch, scanRepo, scanContext } from "../core/scanner.js";
import { fetchPRFiles, postPRComment } from "../core/github.js";
import { detectRulesets } from "../core/detector.js";
import { toMarkdown, toPRComment } from "../core/reporter.js";
import { scanForTraceCode, removeTraceItems } from "../core/trace.js";
import { getConfigStatus } from "../core/config.js";

const server = new McpServer({
  name:    "argus-ci",
  version: "2.0.8",
});

// ─── Tool: scan_files ─────────────────────────────────────────────────────────
// Called by AI agents right after generating/modifying code.

server.tool(
  "scan_files",
  "Run all 6 security & quality passes on specific files: " +
  "(1) Opengrep/Semgrep — OWASP/secrets/injection, " +
  "(2) Bearer — data-flow security, " +
  "(3) quality linter — Oxlint/Ruff/etc., " +
  "(4) ESLint + Prettier — project lint/format, " +
  "(5) dependency audit — CVE/Dependabot, " +
  "(6) SonarQube/Cloud — complexity, code smells, security hotspots. " +
  "Call immediately after generating or modifying code. " +
  "Present ALL engine results (including Sonar) in your FIRST response — never defer any engine to a follow-up.",
  {
    files: z.array(z.string()).describe(
      "List of file paths to scan (relative to cwd or absolute)"
    ),
    cwd: z.string().optional().describe(
      "Working directory / repo root. Defaults to process.cwd()"
    ),
    rulesets: z.array(z.string()).optional().describe(
      "Semgrep rulesets to use. Defaults to auto-detected from stack. " +
      "Examples: p/secrets, p/owasp-top-ten, p/javascript"
    ),
  },
  async ({ files, cwd, rulesets }) => {
    const workdir = cwd ?? process.cwd();
    const detected = detectRulesets(workdir);
    const config = { rulesets: rulesets ?? detected.rulesets };

    const result = await scanFiles(files, workdir, config);
    const markdown = toMarkdown(result, `${files.length} file${files.length !== 1 ? "s" : ""}`);

    const hasErrors = result.issues.some((i) => i.severity === "error");

    return {
      content: [
        {
          type: "text" as const,
          text: markdown,
        },
      ],
      isError: hasErrors,
    };
  }
);

// ─── Tool: scan_staged ────────────────────────────────────────────────────────
// Scans only git-staged files. Designed for pre-commit hook integration.

server.tool(
  "scan_staged",
  "Run all 6 passes (Opengrep, Bearer, ESLint, SonarQube/Cloud, dependency audit, AI enrichment) on git-staged files. " +
  "Use before committing. Present ALL engine results including Sonar in the first response.",
  {
    cwd: z.string().optional().describe("Repo root directory. Defaults to process.cwd()"),
    rulesets: z.array(z.string()).optional().describe("Semgrep rulesets to use. Defaults to auto-detected."),
  },
  async ({ cwd, rulesets }) => {
    const workdir = cwd ?? process.cwd();
    const detected = detectRulesets(workdir);
    const config = { rulesets: rulesets ?? detected.rulesets };

    const result = await scanStaged(workdir, config);
    const markdown = toMarkdown(result, "staged files");

    const hasErrors = result.issues.some((i) => i.severity === "error");

    return {
      content: [{ type: "text" as const, text: markdown }],
      isError: hasErrors,
    };
  }
);

// ─── Tool: scan_branch ────────────────────────────────────────────────────────

server.tool(
  "scan_branch",
  "Run all 6 passes (Opengrep, Bearer, ESLint, SonarQube/Cloud, dependency audit) on all files changed on a branch vs a base branch (default: main). " +
  "Use when asked to review a branch. Present ALL engine results including Sonar in the first response.",
  {
    branch: z.string().describe("Branch name to scan (e.g. feature/auth)"),
    base:   z.string().optional().default("main").describe("Base branch to compare against (default: main)"),
    cwd:    z.string().optional().describe("Repo root. Defaults to process.cwd()"),
    rulesets: z.array(z.string()).optional().describe("Semgrep rulesets. Defaults to auto-detected."),
  },
  async ({ branch, base, cwd, rulesets }) => {
    const workdir = cwd ?? process.cwd();
    const detected = detectRulesets(workdir);
    const config = { rulesets: rulesets ?? detected.rulesets };

    const result = await scanBranch(workdir, branch, base ?? "main", config);
    const markdown = toMarkdown(result, `branch \`${branch}\` vs \`${base ?? "main"}\``);

    const hasErrors = result.issues.some((i) => i.severity === "error");

    return {
      content: [{ type: "text" as const, text: markdown }],
      isError: hasErrors,
    };
  }
);

// ─── Tool: scan_pr ────────────────────────────────────────────────────────────

server.tool(
  "scan_pr",
  "Scan a GitHub Pull Request by URL. Fetches the changed files and runs Semgrep on them. " +
  "Optionally posts results as a PR comment.",
  {
    pr_url: z.string().describe(
      "Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/142"
    ),
    cwd: z.string().optional().describe(
      "Local repo root to scan files from. Required if repo is cloned locally. " +
      "If not provided, files are reported by path only."
    ),
    rulesets: z.array(z.string()).optional().describe("Semgrep rulesets. Defaults to auto-detected."),
    post_comment: z.boolean().optional().default(false).describe(
      "Post scan results as a comment on the PR (requires GITHUB_TOKEN env var)"
    ),
  },
  async ({ pr_url, cwd, rulesets, post_comment }) => {
    // Fetch PR info from GitHub
    let prInfo;
    try {
      prInfo = await fetchPRFiles(pr_url);
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `❌ Failed to fetch PR: ${String(err)}` }],
        isError: true,
      };
    }

    if (!prInfo) {
      return {
        content: [{ type: "text" as const, text: `❌ Could not parse PR URL: ${pr_url}` }],
        isError: true,
      };
    }

    const workdir = cwd ?? process.cwd();
    const detected = detectRulesets(workdir);
    const config = { rulesets: rulesets ?? detected.rulesets };

    const result = await scanFiles(prInfo.files, workdir, config);
    const context = `PR #${prInfo.meta.number}: ${prInfo.meta.title}`;
    const markdown = toMarkdown(result, context);

    // Optionally post to GitHub
    if (post_comment) {
      const comment = toPRComment(result, prInfo.meta.title, prInfo.meta.url);
      const posted = await postPRComment(prInfo.owner, prInfo.repo, prInfo.meta.number, comment);
      const postNote = posted
        ? "\n\n✅ Results posted as PR comment."
        : "\n\n⚠️ Could not post PR comment — check GITHUB_TOKEN.";
      return {
        content: [{ type: "text" as const, text: markdown + postNote }],
        isError: result.issues.some((i) => i.severity === "error"),
      };
    }

    return {
      content: [{ type: "text" as const, text: markdown }],
      isError: result.issues.some((i) => i.severity === "error"),
    };
  }
);

// ─── Tool: scan_repo ──────────────────────────────────────────────────────────

server.tool(
  "scan_repo",
  "Scan the ENTIRE repository for security vulnerabilities AND code quality issues. " +
  "Use this when asked to audit a whole codebase, find all issues, or do a full security review. " +
  "Automatically discovers all source files via git and runs Opengrep (security) + Bearer (data-flow) + Oxlint/Ruff/etc (quality) in one pass.",
  {
    cwd: z.string().optional().describe(
      "Repo root directory. Defaults to process.cwd(). " +
      "Pass the absolute path to the repository you want to scan."
    ),
    rulesets: z.array(z.string()).optional().describe(
      "Override Semgrep rulesets. Defaults to auto-detected from stack."
    ),
  },
  async ({ cwd, rulesets }) => {
    const workdir = cwd ?? process.cwd();
    const detected = detectRulesets(workdir);
    const config = { rulesets: rulesets ?? detected.rulesets };

    const result   = await scanRepo(workdir, config);
    const markdown = toMarkdown(result, `full repository (${result.filesScanned} files)`);
    const hasErrors = result.issues.some((i) => i.severity === "error");

    return {
      content: [{ type: "text" as const, text: markdown }],
      isError: hasErrors,
    };
  }
);

// ─── Tool: scan_context ───────────────────────────────────────────────────────
// Scans the files the AI agent is actively working on. Ideal trigger: end of task.

server.tool(
  "scan_context",
  "Run all 6 security & quality passes on the files modified in this session: " +
  "Opengrep (security), Bearer (data-flow), quality linter, ESLint, dependency audit, and SonarQube/Cloud. " +
  "If `files` is provided, scans exactly those files. " +
  "Otherwise auto-detects all modified files in the git working tree (staged + unstaged changes vs HEAD). " +
  "Use this at the end of any coding task. " +
  "Present ALL engine results (including Sonar) in your FIRST response — never defer any engine to a follow-up.",
  {
    files: z.array(z.string()).optional().describe(
      "Specific files to scan. If omitted, detects modified files from git working tree."
    ),
    cwd: z.string().optional().describe(
      "Repo root. Defaults to process.cwd()"
    ),
  },
  async ({ files, cwd }) => {
    const workdir = cwd ?? process.cwd();
    const result  = await scanContext(workdir, files, {});
    const fileCount = files?.length ?? result.filesScanned;
    const markdown  = toMarkdown(result, `${fileCount} context file${fileCount !== 1 ? "s" : ""}`);
    const hasErrors = result.issues.some((i) => i.severity === "error");

    return {
      content: [{ type: "text" as const, text: markdown }],
      isError: hasErrors,
    };
  }
);

// ─── Tool: find_trace_code ────────────────────────────────────────────────────

server.tool(
  "find_trace_code",
  "Find debug artifacts left in source code: console.log/warn/error, debugger statements, " +
  "TODO/FIXME/HACK comments, and commented-out code blocks. " +
  "Run this before committing to keep the codebase clean.",
  {
    files: z.array(z.string()).describe(
      "File paths to scan for trace code (relative to cwd or absolute)"
    ),
    cwd: z.string().optional().describe(
      "Working directory / repo root. Defaults to process.cwd()"
    ),
  },
  async ({ files, cwd }) => {
    const workdir = cwd ?? process.cwd();
    const result  = scanForTraceCode(files, workdir);

    if (result.items.length === 0) {
      return {
        content: [{ type: "text" as const, text: `✅ No trace code found in ${result.filesScanned} file${result.filesScanned !== 1 ? "s" : ""}.` }],
      };
    }

    const lines: string[] = [
      `## 🔎 Trace code found — ${result.items.length} items in ${result.filesScanned} files`,
      ``,
      `| | Count |`,
      `|---|---|`,
      `| ✅ Safe to auto-remove | ${result.safeCount} |`,
      `| ⚠️  Needs review        | ${result.reviewCount} |`,
      ``,
    ];

    const byFile = new Map<string, typeof result.items>();
    for (const item of result.items) {
      (byFile.get(item.path) ?? byFile.set(item.path, []).get(item.path))!.push(item);
    }

    for (const [file, items] of byFile) {
      lines.push(`### \`${file}\``);
      for (const item of items) {
        const icon = item.safeToRemove ? "✅" : "⚠️";
        lines.push(`- ${icon} **${item.kind}** line ${item.line}: \`${item.sourceLine.slice(0, 80)}\``);
        if (item.removeNote) lines.push(`  > ${item.removeNote}`);
      }
      lines.push("");
    }

    lines.push(`_Use \`remove_trace_code\` to auto-remove the ✅ safe items._`);

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// ─── Tool: remove_trace_code ──────────────────────────────────────────────────

server.tool(
  "remove_trace_code",
  "Automatically remove safe trace code (console.log, debugger) from source files. " +
  "Items requiring review (TODOs, commented-out code) are NOT removed automatically — " +
  "only removed if you explicitly set remove_all=true.",
  {
    files: z.array(z.string()).describe(
      "File paths to scan and clean (relative to cwd or absolute)"
    ),
    cwd: z.string().optional().describe(
      "Working directory / repo root. Defaults to process.cwd()"
    ),
    remove_all: z.boolean().optional().default(false).describe(
      "If true, also removes TODOs and commented-out code blocks (use with caution)"
    ),
  },
  async ({ files, cwd, remove_all }) => {
    const workdir = cwd ?? process.cwd();
    const scan    = scanForTraceCode(files, workdir);

    if (scan.items.length === 0) {
      return {
        content: [{ type: "text" as const, text: `✅ No trace code found — nothing to remove.` }],
      };
    }

    const { removed, skipped, errors } = removeTraceItems(scan.items, workdir, !remove_all);

    const lines: string[] = [`## 🧹 Trace code removal complete`];
    lines.push(``, `✅ Removed: ${removed}`, `⏭ Skipped (line changed): ${skipped}`);
    if (errors.length) {
      lines.push(``, `⚠️ Errors:`);
      for (const e of errors) lines.push(`  - ${e}`);
    }
    if (scan.reviewCount > 0 && !remove_all) {
      lines.push(``, `_ℹ️ ${scan.reviewCount} items need manual review (TODOs, commented code) — set remove_all=true to force remove them._`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Tool: check_setup ────────────────────────────────────────────────────────

server.tool(
  "check_setup",
  "Show the current argus-ci configuration: which scanners are installed, " +
  "which API tokens are set, and what passes are enabled. " +
  "Run this when troubleshooting or to confirm setup is complete.",
  {
    cwd: z.string().optional().describe("Repo root to check. Defaults to process.cwd()"),
  },
  async ({ cwd }) => {
    const workdir = cwd ?? process.cwd();
    const status  = getConfigStatus(workdir);   // pass cwd so per-repo SONAR_PROJECT_KEY is picked up
    const stack   = detectRulesets(workdir);

    const lines: string[] = [
      `## ⚙️ argus-ci setup status`,
      ``,
      `**Detected stack:** ${stack.stack.join(", ") || "none"}`,
      `**Quality engine:** ${stack.qualityEngine ?? "none"}`,
      ``,
      `### API tokens`,
      `| Token | Status |`,
      `|---|---|`,
      `| GROQ_API_KEY      | ${status.groq      ? "✅ set" : "❌ not set (optional — AI fix suggestions)"} |`,
      `| ANTHROPIC_API_KEY | ${status.anthropic  ? "✅ set" : "❌ not set (optional — AI fix suggestions)"} |`,
      `| GITHUB_TOKEN      | ${status.github     ? "✅ set" : "❌ not set (optional — Dependabot alerts)"} |`,
      `| SONAR_TOKEN       | ${status.sonar      ? "✅ set" : "❌ not set (optional — SonarQube/Cloud)"} |`,
      `| SONAR_PROJECT_KEY | ${status.sonarProject ? "✅ set" : "❌ not set (optional)"} |`,
      ``,
      `### Passes enabled`,
      `| Pass | Tool | Status |`,
      `|---|---|---|`,
      `| 1 Security   | Opengrep/Semgrep | always runs |`,
      `| 2 Data-flow  | Bearer           | runs if installed |`,
      `| 3 Quality    | ${stack.qualityEngine ?? "none"} | ${stack.qualityEngine ? "runs if installed" : "no engine detected"} |`,
      `| 4 Project    | ESLint+tsc+Prettier | runs if repo config found |`,
      `| 5 Deps       | npm/pip/bundler/cargo audit + Dependabot | runs if manifest found |`,
      `| 6 Sonar      | SonarQube/Cloud  | ${status.sonar ? "✅ enabled" : "❌ requires SONAR_TOKEN"} |`,
      `| + AI         | Groq/Anthropic   | ${(status.groq || status.anthropic) ? "✅ enabled" : "❌ requires API key"} |`,
      ``,
      `_Run \`npx argus-ci setup --configure\` to add missing tokens._`,
    ];

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
