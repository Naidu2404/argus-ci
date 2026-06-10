/**
 * Optional AI fix suggestions layer.
 *
 * When GROQ_API_KEY or ANTHROPIC_API_KEY is set, this enriches each finding
 * with a one-line "here's exactly what to change" suggestion.
 *
 * Provider auto-detection (uses whichever key is present):
 *   GROQ_API_KEY      → Groq / llama-3.1-8b-instant  (free, fast)
 *   ANTHROPIC_API_KEY → Claude Haiku                   (fast, accurate)
 *
 * Batches findings per file to minimise API calls.
 * Gracefully skips if no key is configured — all other passes still work.
 */

import { getGroqKey, getAnthropicKey } from "./config.js";
import type { Issue, ScanResult }       from "../types.js";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enriches scan results with AI-generated fix suggestions.
 * Mutates issue.fixSuggestion in place; returns the same result object.
 */
export async function enrichWithAI(result: ScanResult): Promise<ScanResult> {
  if (result.skipped || result.issues.length === 0) return result;

  const { provider, apiKey } = detectProvider();
  if (!provider) return result;   // no key configured — skip silently

  // Only enrich error-level findings to keep API usage minimal
  const targets = result.issues.filter(
    (i) => i.severity === "error" && !i.fixSuggestion
  );
  if (targets.length === 0) return result;

  try {
    const suggestions = await batchSuggest(targets, provider, apiKey!);
    for (let i = 0; i < targets.length; i++) {
      if (suggestions[i]) targets[i]!.fixSuggestion = suggestions[i];
    }
  } catch {
    // AI enrichment is best-effort — never fail the scan
  }

  return result;
}

// ─── Provider detection ───────────────────────────────────────────────────────

type Provider = "groq" | "anthropic";

function detectProvider(): { provider: Provider | null; apiKey: string | undefined } {
  const groq      = getGroqKey();
  const anthropic = getAnthropicKey();
  if (groq)      return { provider: "groq",      apiKey: groq      };
  if (anthropic) return { provider: "anthropic", apiKey: anthropic };
  return { provider: null, apiKey: undefined };
}

// ─── Batch suggestions ────────────────────────────────────────────────────────

async function batchSuggest(
  issues:   Issue[],
  provider: Provider,
  apiKey:   string,
): Promise<(string | undefined)[]> {
  // Cap at 20 issues per call to keep prompts manageable
  const batch   = issues.slice(0, 20);
  const prompt  = buildPrompt(batch);

  const rawResp = provider === "groq"
    ? await callGroq(prompt, apiKey)
    : await callAnthropic(prompt, apiKey);

  return parseResponses(rawResp, batch.length);
}

function buildPrompt(issues: Issue[]): string {
  const items = issues
    .map((iss, idx) =>
      `${idx + 1}. [${iss.ruleId}] ${iss.path}:${iss.line} — ${iss.message}` +
      (iss.sourceLine ? `\n   Code: ${iss.sourceLine.slice(0, 150)}` : "")
    )
    .join("\n");

  return `You are a code review assistant. For each issue below, provide a single-line fix instruction (max 120 chars). Be specific: name the exact change. Reply with numbered lines matching the input — nothing else.\n\n${items}`;
}

function parseResponses(raw: string, count: number): (string | undefined)[] {
  const results: (string | undefined)[] = new Array(count).fill(undefined);
  const lines = raw.split("\n").filter((l) => /^\d+\./.test(l.trim()));
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s+(.+)/);
    if (!m) continue;
    const idx = parseInt(m[1]!, 10) - 1;
    if (idx >= 0 && idx < count) results[idx] = m[2]!.trim();
  }
  return results;
}

// ─── Groq API ─────────────────────────────────────────────────────────────────

async function callGroq(prompt: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body:    JSON.stringify({
      model:       "llama-3.1-8b-instant",
      messages:    [{ role: "user", content: prompt }],
      max_tokens:  500,
      temperature: 0,
    }),
  });

  if (!res.ok) throw new Error(`Groq API ${res.status}`);
  const body = await res.json() as { choices: Array<{ message: { content: string } }> };
  return body.choices[0]?.message.content ?? "";
}

// ─── Anthropic API ────────────────────────────────────────────────────────────

async function callAnthropic(prompt: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages:   [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const body = await res.json() as { content: Array<{ type: string; text: string }> };
  return body.content.find((b) => b.type === "text")?.text ?? "";
}
