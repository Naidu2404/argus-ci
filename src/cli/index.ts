/**
 * argus-ci CLI v2.0.0
 *
 * Commands:
 *   argus-ci                        Start MCP server (default, for Cursor/Claude)
 *   argus-ci chat                   Start conversational agent REPL
 *   argus-ci scan [files]           Scan files / staged / branch / repo from terminal
 *   argus-ci pr <url>               Scan a PR directly
 *   argus-ci setup                  Install pre-commit hook in current repo
 *   argus-ci setup --configure      Interactive credential wizard (API keys)
 *   argus-ci setup --remove         Remove the pre-commit hook
 */

import { scanFiles, scanStaged, scanBranch, scanRepo } from "../core/scanner.js";
import { detectRulesets } from "../core/detector.js";
import { toMarkdown, toCompact } from "../core/reporter.js";
import { runAgent, startRepl } from "../agent/index.js";
import { setupHook } from "../hooks/setup.js";
import type { ScanResult } from "../types.js";

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {

    // ── chat — conversational agent REPL ─────────────────────────────────────
    case "chat": {
      const prompt = args.slice(1).join(" ");
      if (prompt) {
        await runAgent(prompt);
      } else {
        await startRepl();
      }
      break;
    }

    // ── scan — scan files, staged, or a branch ────────────────────────────────
    case "scan": {
      const cwd = process.cwd();
      const detected = detectRulesets(cwd);
      const config = { rulesets: detected.rulesets };

      let result: ScanResult;

      const subArg = args[1];
      if (!subArg || subArg === "--staged") {
        // scan staged files
        result = await scanStaged(cwd, config);
      } else if (subArg === "--repo" || subArg === "-r") {
        // full repo scan — all 6 passes
        result = await scanRepo(cwd, config);
      } else if (subArg === "--branch" || subArg === "-b") {
        const branch = args[2];
        const base   = args[3] ?? "main";
        if (!branch) { console.error("Usage: argus-ci scan --branch <branch> [base]"); process.exit(1); }
        result = await scanBranch(cwd, branch, base, config);
      } else {
        // treat remaining args as file paths
        const files = args.slice(1).filter((a) => !a.startsWith("--"));
        result = await scanFiles(files, cwd, config);
      }

      const markdown = toMarkdown(result);
      console.log(markdown);

      const hasErrors = result.issues.some((i) => i.severity === "error");
      process.exit(hasErrors ? 1 : 0);
      break;
    }

    // ── pr — scan a GitHub PR ─────────────────────────────────────────────────
    case "pr": {
      const prUrl = args[1];
      if (!prUrl) {
        console.error("Usage: argus-ci pr <github-pr-url>");
        process.exit(1);
      }
      await runAgent(`Review PR ${prUrl} and give me a full security and quality report`);
      break;
    }

    // ── setup — install pre-commit hook ───────────────────────────────────────
    case "setup": {
      const cwd = process.cwd();
      await setupHook(cwd);
      break;
    }

    // ── version ───────────────────────────────────────────────────────────────
    case "--version":
    case "-v": {
      const { createRequire } = await import("module");
      const require = createRequire(import.meta.url);
      const pkg = require("../../package.json") as { version: string };
      console.log(`argus-ci v${pkg.version}`);
      break;
    }

    // ── help ──────────────────────────────────────────────────────────────────
    case "--help":
    case "-h":
    case "help":
    case undefined: {
      // No command = start MCP server (main use case when added to Cursor/Claude)
      await import("../mcp/server.js");
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
argus-ci v2.0.0 — 6-pass security & quality agent with MCP server

USAGE
  argus-ci                          Start MCP server (add to Cursor / Claude Code)
  argus-ci chat                     Start conversational agent REPL
  argus-ci chat "review PR <url>"   Run a one-shot agent request
  argus-ci scan                     Scan staged files (6 passes)
  argus-ci scan --staged            Scan staged files (explicit)
  argus-ci scan --repo              Scan entire repository (all 6 passes)
  argus-ci scan --branch <name>     Scan a branch vs main
  argus-ci scan file1 file2         Scan specific files
  argus-ci pr <github-url>          Scan a GitHub PR
  argus-ci setup                    Install pre-commit hook in current repo
  argus-ci setup --configure        Interactive API key wizard (Groq, GitHub, Sonar)
  argus-ci setup --remove           Remove the pre-commit hook
  argus-ci --version                Show version

6 PASSES
  1. Opengrep / Semgrep  — security patterns + OWASP + secrets (always)
  2. Bearer              — deep data-flow security
  3. Quality engine      — Oxlint / Ruff / golangci-lint / RuboCop / PMD / PHPStan
  4. Project checks      — ESLint + tsc + Prettier (uses repo's own config)
  5. Dependency audit    — npm audit / pip-audit / bundler-audit + Dependabot
  6. SonarQube/Cloud     — open issues from your Sonar project

CONFIGURATION (optional — enhances results)
  Run: npx argus-ci setup --configure
  Sets: GROQ_API_KEY (AI fix hints), GITHUB_TOKEN (Dependabot), SONAR_TOKEN

ADD TO CURSOR (Settings → MCP):
  { "argus-ci": { "command": "npx", "args": ["argus-ci"] } }

ADD TO CLAUDE CODE (~/.claude/settings.json):
  { "mcpServers": { "argus-ci": { "command": "npx", "args": ["argus-ci"] } } }
`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
