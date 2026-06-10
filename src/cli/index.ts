/**
 * argus-ci CLI v2.0.1
 *
 * Commands:
 *   argus-ci                        Start MCP server (default when invoked by Cursor/Claude)
 *   argus-ci help                   Show help
 *   argus-ci check_setup            Show configuration status (tokens, passes, stack)
 *   argus-ci scan                   Scan staged files (6 passes)
 *   argus-ci scan --repo            Scan entire repository
 *   argus-ci scan --context         Scan modified files in working tree
 *   argus-ci scan --branch <name>   Scan a branch vs main
 *   argus-ci scan <file> [file…]    Scan specific files
 *   argus-ci pr <url>               Scan a GitHub PR
 *   argus-ci setup                  Install pre-commit hook in current repo
 *   argus-ci setup --configure      Interactive API key wizard
 *   argus-ci setup --remove         Remove the pre-commit hook
 */

import { scanFiles, scanStaged, scanBranch, scanRepo, scanContext } from "../core/scanner.js";
import { detectRulesets } from "../core/detector.js";
import { toMarkdown } from "../core/reporter.js";
import { getConfigStatus } from "../core/config.js";
import { runAgent, startRepl } from "../agent/index.js";
import { setupHook } from "../hooks/setup.js";
import type { ScanResult } from "../types.js";

const args    = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {

    // ── MCP server — default when no command (Cursor/Claude Code invokes this) ──
    case undefined: {
      await import("../mcp/server.js");
      break;
    }

    // ── help ──────────────────────────────────────────────────────────────────
    case "help":
    case "--help":
    case "-h": {
      printHelp();
      break;
    }

    // ── check_setup — show token/pass/stack status ────────────────────────────
    case "check_setup":
    case "status": {
      const cwd    = process.cwd();
      const status = getConfigStatus();
      const stack  = detectRulesets(cwd);

      console.log(`
⚙️  argus-ci setup status
${"─".repeat(50)}

Detected stack  : ${stack.stack.join(", ") || "none"}
Quality engine  : ${stack.qualityEngine ?? "none (no supported stack detected)"}

API tokens
  GROQ_API_KEY       : ${status.groq        ? "✅ set  — AI fix suggestions enabled (Pass +AI)" : "❌ not set  (optional — free at console.groq.com)"}
  ANTHROPIC_API_KEY  : ${status.anthropic   ? "✅ set  — AI fix suggestions enabled (Pass +AI)" : "❌ not set  (optional)"}
  GITHUB_TOKEN       : ${status.github      ? "✅ set  — Dependabot alerts enabled (Pass 5)"    : "❌ not set  (optional — github.com/settings/tokens)"}
  SONAR_TOKEN        : ${status.sonar       ? "✅ set"                                          : "❌ not set  (optional — sonarcloud.io/account/security)"}
  SONAR_PROJECT_KEY  : ${status.sonarProject? "✅ set"                                          : "❌ not set  (optional)"}

Passes
  1  Security   Opengrep/Semgrep    always runs
  2  Data-flow  Bearer              runs if installed
  3  Quality    ${(stack.qualityEngine ?? "—").padEnd(18)}  ${stack.qualityEngine ? "runs if installed" : "no engine detected — run: npx argus-ci setup"}
  4  Project    ESLint+tsc+Prettier runs if repo config found
  5  Deps       npm audit + Dependabot runs if lockfile found
  6  Sonar      SonarQube/Cloud     ${status.sonar && status.sonarProject ? "✅ active" : "❌ needs SONAR_TOKEN + SONAR_PROJECT_KEY"}
  +  AI         Groq / Anthropic    ${(status.groq || status.anthropic) ? "✅ active" : "❌ needs GROQ_API_KEY or ANTHROPIC_API_KEY"}

Run \`npx argus-ci setup --configure\` to add missing tokens.
`);
      break;
    }

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

    // ── scan — scan files, staged, context, branch, or entire repo ────────────
    case "scan": {
      const cwd      = process.cwd();
      const detected = detectRulesets(cwd);
      const config   = { rulesets: detected.rulesets };
      let result: ScanResult;

      const subArg = args[1];

      if (!subArg || subArg === "--staged") {
        result = await scanStaged(cwd, config);

      } else if (subArg === "--repo" || subArg === "-r") {
        console.error("🔍 Scanning entire repository (all 6 passes) — this may take a minute...");
        result = await scanRepo(cwd, config);

      } else if (subArg === "--context" || subArg === "-c") {
        // Scan modified files in working tree (staged + unstaged)
        const explicitFiles = args.slice(2).filter((a) => !a.startsWith("--"));
        result = await scanContext(cwd, explicitFiles.length ? explicitFiles : undefined, config);

      } else if (subArg === "--branch" || subArg === "-b") {
        const branch = args[2];
        const base   = args[3] ?? "main";
        if (!branch) {
          console.error("Usage: argus-ci scan --branch <branch-name> [base-branch]");
          process.exit(1);
        }
        result = await scanBranch(cwd, branch, base, config);

      } else {
        // Treat remaining args as file paths
        const files = args.slice(1).filter((a) => !a.startsWith("--"));
        if (files.length === 0) {
          console.error("No files specified. Usage: argus-ci scan <file1> [file2 ...]");
          process.exit(1);
        }
        result = await scanFiles(files, cwd, config);
      }

      console.log(toMarkdown(result));
      process.exit(result.issues.some((i) => i.severity === "error") ? 1 : 0);
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

    // ── setup — install hook / configure credentials / remove ─────────────────
    case "setup": {
      await setupHook(process.cwd());
      break;
    }

    // ── version ───────────────────────────────────────────────────────────────
    case "--version":
    case "version":
    case "-v": {
      const { createRequire } = await import("module");
      const require = createRequire(import.meta.url);
      const pkg = require("../../package.json") as { version: string };
      console.log(`argus-ci v${pkg.version}`);
      break;
    }

    default: {
      console.error(`\nUnknown command: ${command}\n`);
      printHelp();
      process.exit(1);
    }
  }
}

function printHelp(): void {
  console.log(`
argus-ci v2.0.1 — 6-pass security & quality agent

USAGE
  argus-ci                           Start MCP server (Cursor / Claude Code)
  argus-ci help                      Show this help
  argus-ci check_setup               Show token status, active passes, detected stack
  argus-ci scan                      Scan git-staged files
  argus-ci scan --staged             Scan git-staged files (explicit)
  argus-ci scan --context            Scan all modified files (staged + unstaged)
  argus-ci scan --repo               Scan entire repository (all 6 passes, all files)
  argus-ci scan --branch <name>      Scan a branch vs main
  argus-ci scan <file> [file…]       Scan specific files
  argus-ci pr <github-url>           Scan a GitHub PR
  argus-ci chat                      Start conversational agent REPL
  argus-ci chat "<prompt>"           One-shot agent request
  argus-ci setup                     Install pre-commit hook + scanners
  argus-ci setup --configure         Interactive wizard: add Groq/GitHub/Sonar keys
  argus-ci setup --remove            Remove the pre-commit hook
  argus-ci version                   Show version

6 PASSES
  1. Opengrep / Semgrep  — security patterns, OWASP, secrets (always runs)
  2. Bearer              — deep data-flow security
  3. Quality engine      — Oxlint / Ruff / golangci-lint / RuboCop / PMD / PHPStan
  4. Project checks      — ESLint + tsc + Prettier (uses repo's own config)
  5. Dependency audit    — npm/pip/bundler/cargo audit + Dependabot
  6. SonarQube / Cloud   — open issues from your Sonar project

OPTIONAL CONFIGURATION (unlocks more passes)
  npx argus-ci setup --configure
    GROQ_API_KEY       → AI fix suggestions on every error  (free: console.groq.com)
    GITHUB_TOKEN       → Dependabot vulnerability alerts    (github.com/settings/tokens)
    SONAR_TOKEN        → SonarQube/Cloud issues             (sonarcloud.io/account/security)
    SONAR_PROJECT_KEY  → Your Sonar project key

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
