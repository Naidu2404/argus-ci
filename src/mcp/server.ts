/**
 * Semgrep Agent — MCP Server
 *
 * Exposes four tools to Cursor / Claude Code / any MCP client:
 *
 *   scan_repo    — scan entire repository (all source files, all passes)
 *   scan_files   — scan specific files (called post code-generation)
 *   scan_staged  — scan git staged files (pre-commit check)
 *   scan_branch  — scan changed files on a branch vs base
 *   scan_pr      — scan a GitHub PR by URL
 *
 * Add to Cursor: Settings → MCP → add entry:
 *   { "command": "npx", "args": ["argus-ci"] }
 *
 * Add to Claude Code (~/.claude/settings.json):
 *   { "mcpServers": { "semgrep": { "command": "npx", "args": ["argus-ci"] } } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { scanFiles, scanStaged, scanBranch, scanRepo } from "../core/scanner.js";
import { fetchPRFiles, postPRComment } from "../core/github.js";
import { detectRulesets } from "../core/detector.js";
import { toMarkdown, toPRComment } from "../core/reporter.js";

const server = new McpServer({
  name:    "argus",
  version: "1.0.0",
});

// ─── Tool: scan_files ─────────────────────────────────────────────────────────
// Called by AI agents right after generating/modifying code.

server.tool(
  "scan_files",
  "Scan specific files with Semgrep for security vulnerabilities and quality issues. " +
  "Call this immediately after generating or modifying code files.",
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
  "Scan all git-staged files with Semgrep. Use this before committing to catch issues in code about to be committed.",
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
  "Scan all files changed on a branch compared to a base branch (default: main). " +
  "Use when asked to review a branch or check what a feature branch introduces.",
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

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
