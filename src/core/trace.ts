/**
 * Trace code scanner — finds debug artifacts left in source:
 *   • console.log / warn / error / debug / info calls
 *   • debugger statements
 *   • TODO / FIXME / HACK / XXX comments
 *   • Large commented-out code blocks (3+ consecutive comment lines with code)
 *
 * Used by the find_trace_code and remove_trace_code MCP tools.
 * Fast — pure regex, no AST, works on any language.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join }                                     from "path";
import type { TraceItem, TraceResult }              from "../types.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export function scanForTraceCode(files: string[], cwd: string): TraceResult {
  const items: TraceItem[] = [];

  for (const file of files) {
    const abs = file.startsWith("/") ? file : join(cwd, file);
    if (!existsSync(abs)) continue;

    let content: string;
    try { content = readFileSync(abs, "utf8"); }
    catch { continue; }

    items.push(...scanFile(file, content));
  }

  const safeCount   = items.filter((i) => i.safeToRemove).length;
  const reviewCount = items.filter((i) => !i.safeToRemove).length;

  return { items, filesScanned: files.length, safeCount, reviewCount };
}

/**
 * Remove safe trace items from files.
 * Returns a summary of what was removed.
 */
export function removeTraceItems(
  items: TraceItem[],
  cwd:   string,
  onlySafe = true
): { removed: number; skipped: number; errors: string[] } {
  // Group by file, sort by line descending (remove from bottom up so line numbers stay valid)
  const byFile = new Map<string, TraceItem[]>();
  for (const item of items) {
    if (onlySafe && !item.safeToRemove) continue;
    (byFile.get(item.path) ?? byFile.set(item.path, []).get(item.path))!.push(item);
  }

  let removed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const [filePath, fileItems] of byFile) {
    const abs = filePath.startsWith("/") ? filePath : join(cwd, filePath);
    if (!existsSync(abs)) { errors.push(`File not found: ${filePath}`); continue; }

    let lines: string[];
    try { lines = readFileSync(abs, "utf8").split("\n"); }
    catch (err) { errors.push(`Cannot read ${filePath}: ${String(err)}`); continue; }

    // Sort descending by line so removals don't shift indices
    const sorted = [...fileItems].sort((a, b) => (b.endLine ?? b.line) - (a.endLine ?? a.line));

    for (const item of sorted) {
      const startIdx = item.line - 1;          // 0-based
      const endIdx   = (item.endLine ?? item.line) - 1;

      // Verify the line still matches what we expected (content didn't change since scan)
      if (lines[startIdx]?.trim() !== item.sourceLine.trim()) {
        skipped++;
        continue;
      }

      lines.splice(startIdx, endIdx - startIdx + 1);
      removed++;
    }

    try {
      writeFileSync(abs, lines.join("\n"), "utf8");
    } catch (err) {
      errors.push(`Cannot write ${filePath}: ${String(err)}`);
    }
  }

  return { removed, skipped, errors };
}

// ─── Per-file scanner ─────────────────────────────────────────────────────────

function scanFile(filePath: string, content: string): TraceItem[] {
  const lines  = content.split("\n");
  const items: TraceItem[] = [];
  const ext    = filePath.split(".").pop()?.toLowerCase() ?? "";
  const isCode = CODE_EXTS.has(ext);

  if (!isCode) return [];

  // ── 1. console.* calls ───────────────────────────────────────────────────
  const CONSOLE_RE = /^\s*console\.(log|warn|error|debug|info|trace|dir|table)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    if (CONSOLE_RE.test(lines[i]!)) {
      items.push({
        path: filePath, line: i + 1,
        kind: "console",
        sourceLine: lines[i]!.trim(),
        safeToRemove: true,
      });
    }
  }

  // ── 2. debugger statements ───────────────────────────────────────────────
  const DEBUGGER_RE = /^\s*debugger\s*;?\s*$/;
  for (let i = 0; i < lines.length; i++) {
    if (DEBUGGER_RE.test(lines[i]!)) {
      items.push({
        path: filePath, line: i + 1,
        kind: "debugger",
        sourceLine: lines[i]!.trim(),
        safeToRemove: true,
      });
    }
  }

  // ── 3. TODO / FIXME / HACK / XXX comments ───────────────────────────────
  const TODO_RE = /[/#*]\s*(TODO|FIXME|HACK|XXX|BUG|TEMP)\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (TODO_RE.test(lines[i]!)) {
      items.push({
        path: filePath, line: i + 1,
        kind: "todo-comment",
        sourceLine: lines[i]!.trim(),
        safeToRemove: false,
        removeNote: "Review this TODO before removing — may describe intentional missing work",
      });
    }
  }

  // ── 4. Commented-out code blocks (3+ consecutive comment lines with code) ─
  items.push(...findCommentedCodeBlocks(filePath, lines));

  return items;
}

function findCommentedCodeBlocks(filePath: string, lines: string[]): TraceItem[] {
  const items: TraceItem[] = [];
  // Matches lines that are purely a comment and contain code-like content
  const COMMENT_LINE_RE    = /^\s*(\/\/|#|--)\s*.+/;
  const CODE_IN_COMMENT_RE = /[=(){};,[\]=>]|function |const |let |var |return |if |for |import /;

  let blockStart = -1;
  let blockLen   = 0;

  for (let i = 0; i <= lines.length; i++) {
    const line = lines[i] ?? "";
    const isCommentedCode =
      COMMENT_LINE_RE.test(line) && CODE_IN_COMMENT_RE.test(line);

    if (isCommentedCode) {
      if (blockStart === -1) blockStart = i;
      blockLen++;
    } else {
      if (blockLen >= 3) {
        // Emit the block
        items.push({
          path:        filePath,
          line:        blockStart + 1,
          endLine:     blockStart + blockLen,
          kind:        "commented-code",
          sourceLine:  (lines[blockStart] ?? "").trim(),
          safeToRemove: false,
          removeNote:  `${blockLen}-line commented-out code block — verify it's no longer needed`,
        });
      }
      blockStart = -1;
      blockLen   = 0;
    }
  }

  return items;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte",
  "py", "go", "java", "kt", "rb", "php", "swift", "cs", "cpp", "c",
]);
