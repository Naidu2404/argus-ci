/**
 * Semgrep Agent — Conversational Interface
 *
 * A Claude-powered agent that understands natural language requests
 * and runs the appropriate Semgrep scan.
 *
 * Usage:
 *   argus-ci chat
 *   echo "review PR https://github.com/org/repo/pull/142" | argus-ci chat
 *
 * Requires: ANTHROPIC_API_KEY env var
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { scanFiles, scanStaged, scanBranch } from "../core/scanner.js";
import { fetchPRFiles } from "../core/github.js";
import { detectRulesets } from "../core/detector.js";
import { toMarkdown } from "../core/reporter.js";
import type { ScanConfig } from "../types.js";

const MODEL = "claude-opus-4-6";

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "scan_files",
    description: "Scan specific files with Semgrep for security issues.",
    input_schema: {
      type: "object" as const,
      properties: {
        files:    { type: "array", items: { type: "string" }, description: "File paths to scan" },
        cwd:      { type: "string", description: "Repo root directory" },
        rulesets: { type: "array", items: { type: "string" }, description: "Semgrep rulesets" },
      },
      required: ["files"],
    },
  },
  {
    name: "scan_staged",
    description: "Scan all git-staged files. Use when asked to check current changes before committing.",
    input_schema: {
      type: "object" as const,
      properties: {
        cwd:      { type: "string", description: "Repo root directory" },
        rulesets: { type: "array", items: { type: "string" } },
      },
      required: [],
    },
  },
  {
    name: "scan_branch",
    description: "Scan files changed on a branch compared to a base branch.",
    input_schema: {
      type: "object" as const,
      properties: {
        branch:   { type: "string", description: "Branch to scan" },
        base:     { type: "string", description: "Base branch (default: main)" },
        cwd:      { type: "string" },
        rulesets: { type: "array", items: { type: "string" } },
      },
      required: ["branch"],
    },
  },
  {
    name: "scan_pr",
    description: "Scan a GitHub Pull Request by URL.",
    input_schema: {
      type: "object" as const,
      properties: {
        pr_url:       { type: "string", description: "GitHub PR URL" },
        cwd:          { type: "string" },
        rulesets:     { type: "array", items: { type: "string" } },
        post_comment: { type: "boolean", description: "Post results as PR comment" },
      },
      required: ["pr_url"],
    },
  },
];

// ─── Tool executor ────────────────────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  const cwd = (input.cwd as string | undefined) ?? process.cwd();
  const detected = detectRulesets(cwd);
  const config: ScanConfig = {
    rulesets: (input.rulesets as string[] | undefined) ?? detected.rulesets,
  };

  try {
    switch (name) {
      case "scan_files": {
        const files = input.files as string[];
        const result = await scanFiles(files, cwd, config);
        return toMarkdown(result, `${files.length} file(s)`);
      }

      case "scan_staged": {
        const result = await scanStaged(cwd, config);
        return toMarkdown(result, "staged files");
      }

      case "scan_branch": {
        const branch = input.branch as string;
        const base   = (input.base as string | undefined) ?? "main";
        const result = await scanBranch(cwd, branch, base, config);
        return toMarkdown(result, `branch \`${branch}\` vs \`${base}\``);
      }

      case "scan_pr": {
        const prUrl = input.pr_url as string;
        const prInfo = await fetchPRFiles(prUrl);
        if (!prInfo) return `❌ Could not parse PR URL: ${prUrl}`;

        const result = await scanFiles(prInfo.files, cwd, config);
        return toMarkdown(result, `PR #${prInfo.meta.number}: ${prInfo.meta.title}`);
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `❌ Tool error: ${String(err)}`;
  }
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

export async function runAgent(userMessage: string): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("❌ ANTHROPIC_API_KEY not set. Export it or add to .argus-ci.json");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const systemPrompt = `You are a code security and quality agent powered by Semgrep.
Your job is to run security scans on code and clearly explain the findings.

When the user asks you to:
- "scan files X, Y, Z" → use scan_files
- "check my changes" / "check staged files" / "before I commit" → use scan_staged
- "review branch X" / "check branch X" → use scan_branch
- "review PR <url>" / "scan PR #N" → use scan_pr

After getting scan results:
1. Summarise the findings clearly (errors first, then warnings)
2. For each finding, explain WHY it's a security risk in plain language
3. Give a concrete one-line fix for each issue
4. If no issues, confirm the code looks clean and what was checked

Always be specific: name the file, the line, and the exact variable or function involved.
Use the current working directory (${process.cwd()}) unless the user specifies otherwise.`;

  // Agentic loop
  while (true) {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 4096,
      system:     systemPrompt,
      tools:      TOOLS,
      messages,
    });

    // Collect text output as we go
    for (const block of response.content) {
      if (block.type === "text") {
        process.stdout.write(block.text);
      }
    }

    if (response.stop_reason === "end_turn") {
      process.stdout.write("\n");
      break;
    }

    if (response.stop_reason === "tool_use") {
      // Execute all tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          process.stdout.write(`\n⚙️  Running ${block.name}...\n`);
          const result = await executeTool(block.name, block.input as Record<string, unknown>);
          toolResults.push({
            type:        "tool_result",
            tool_use_id: block.id,
            content:     result,
          });
        }
      }

      // Add assistant turn + tool results
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user",      content: toolResults });
      continue;
    }

    break;
  }
}

// ─── Interactive REPL ─────────────────────────────────────────────────────────

export async function startRepl(): Promise<void> {
  console.log("🔍 Semgrep Agent — type your request or 'exit' to quit\n");
  console.log("Examples:");
  console.log("  review PR https://github.com/org/repo/pull/42");
  console.log("  scan branch feature/auth");
  console.log("  check my staged changes\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (): void => {
    rl.question("You: ", async (line) => {
      const input = line.trim();
      if (!input || input === "exit" || input === "quit") {
        rl.close();
        return;
      }
      console.log("");
      await runAgent(input);
      console.log("\n" + "─".repeat(60) + "\n");
      ask();
    });
  };

  ask();
}
