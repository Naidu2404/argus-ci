/**
 * argus-ci setup — single command that does everything:
 *   1. Auto-installs Semgrep if missing (brew on macOS, pip3 elsewhere)
 *   2. Copies CLAUDE.md + .cursorrules trigger files into the repo
 *   3. Installs the pre-commit git hook
 *
 * Usage: npx argus-ci setup
 */

import {
  existsSync, mkdirSync, writeFileSync,
  chmodSync, readFileSync, copyFileSync,
} from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { platform } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Resolve the package root (two levels up from dist/hooks/)
const PKG_ROOT = join(__dirname, "..", "..");

const HOOK_MARKER = "# argus-ci-hook";

const HOOK_SCRIPT = `#!/usr/bin/env sh
${HOOK_MARKER}
# Semgrep quality gate — runs on every commit.
# Remove with: npx argus-ci setup --remove
# Bypass (emergency only): git commit --no-verify

echo "🔍 argus-ci: scanning staged files..."

npx --yes argus-ci scan --staged
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo "❌ Security issues found — commit blocked."
  echo "   Fix the issues above, then commit again."
  echo "   Emergency bypass: git commit --no-verify"
  exit 1
fi

echo "✅ argus-ci: all clear."
exit 0
`;

// ─── Main export ──────────────────────────────────────────────────────────────

export async function setupHook(cwd: string): Promise<void> {
  const remove = process.argv.includes("--remove");

  if (remove) {
    const hookPath = join(cwd, ".git", "hooks", "pre-commit");
    await removeHook(hookPath);
    return;
  }

  console.log("\n🚀 argus-ci setup\n");

  // Step 1: ensure Semgrep is installed
  await ensureSemgrep();

  // Step 2: copy trigger files into the repo
  copyTriggerFiles(cwd);

  // Step 3: install the pre-commit hook
  installPreCommitHook(cwd);

  console.log(`
✅ Setup complete. argus-ci is now active in this repo.

  What happens next:
  • Every file your AI agent writes is scanned automatically (via MCP)
  • Every commit is scanned — errors block the commit
  • CLAUDE.md and .cursorrules tell your AI agent to run scans automatically

  To review a PR:     npx argus-ci pr <github-url>
  To remove the hook: npx argus-ci setup --remove
`);
}

// ─── Step 1: auto-install Semgrep ────────────────────────────────────────────

async function ensureSemgrep(): Promise<void> {
  if (isSemgrepInstalled()) {
    const v = getSemgrepVersion();
    console.log(`  ✓ Semgrep already installed (${v})`);
    return;
  }

  console.log("  ⚙️  Semgrep not found — installing automatically...");

  const os = platform();
  let installed = false;

  if (os === "darwin") {
    // Try Homebrew first on macOS
    if (commandExists("brew")) {
      console.log("     → brew install semgrep");
      const r = spawnSync("brew", ["install", "semgrep"], { stdio: "inherit" });
      installed = r.status === 0;
    }
  }

  if (!installed) {
    // Fallback: pip3 / pip (works on macOS, Linux, Windows)
    const pipCmd = commandExists("pip3") ? "pip3" : "pip";
    console.log(`     → ${pipCmd} install semgrep`);
    const r = spawnSync(pipCmd, ["install", "semgrep"], { stdio: "inherit" });
    installed = r.status === 0;
  }

  if (!installed || !isSemgrepInstalled()) {
    console.error(`
  ❌ Could not install Semgrep automatically.
     Please install it manually then re-run setup:

       brew install semgrep   (macOS)
       pip install semgrep    (any platform)
`);
    process.exit(1);
  }

  const v = getSemgrepVersion();
  console.log(`  ✓ Semgrep installed (${v})`);
}

function isSemgrepInstalled(): boolean {
  const candidates = ["semgrep", "/usr/local/bin/semgrep", "/opt/homebrew/bin/semgrep"];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return true;
  }
  // Try python module form
  const r = spawnSync("python3", ["-m", "semgrep", "--version"], { encoding: "utf8" });
  return r.status === 0;
}

function getSemgrepVersion(): string {
  const r = spawnSync("semgrep", ["--version"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim().split("\n")[0];
  const r2 = spawnSync("python3", ["-m", "semgrep", "--version"], { encoding: "utf8" });
  return r2.stdout?.trim().split("\n")[0] ?? "unknown";
}

function commandExists(cmd: string): boolean {
  const r = spawnSync(platform() === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0;
}

// ─── Step 2: copy trigger files ───────────────────────────────────────────────

function copyTriggerFiles(cwd: string): void {
  const files = [
    { src: join(PKG_ROOT, "CLAUDE.md"),     dest: join(cwd, "CLAUDE.md") },
    { src: join(PKG_ROOT, ".cursorrules"),  dest: join(cwd, ".cursorrules") },
  ];

  for (const { src, dest } of files) {
    if (!existsSync(src)) {
      console.log(`  ⚠️  Could not find ${src} in package — skipping`);
      continue;
    }

    if (existsSync(dest)) {
      // Check if already contains argus-ci instructions
      const existing = readFileSync(dest, "utf8");
      if (existing.includes("argus-ci") || existing.includes("scan_files")) {
        console.log(`  ✓ ${dest.split("/").pop()} already contains argus-ci instructions`);
        continue;
      }
      // Append to existing file
      const appended = existing.trimEnd() + "\n\n" + readFileSync(src, "utf8");
      writeFileSync(dest, appended, "utf8");
      console.log(`  ✓ argus-ci instructions appended to existing ${dest.split("/").pop()}`);
    } else {
      copyFileSync(src, dest);
      console.log(`  ✓ ${dest.split("/").pop()} written`);
    }
  }
}

// ─── Step 3: install pre-commit hook ─────────────────────────────────────────

function installPreCommitHook(cwd: string): void {
  const gitDir = join(cwd, ".git");
  if (!existsSync(gitDir)) {
    console.warn("  ⚠️  No .git directory found — skipping pre-commit hook");
    console.warn("      Run from a git repo root to install the commit gate.");
    return;
  }

  const hooksDir = join(gitDir, "hooks");
  const hookPath = join(hooksDir, "pre-commit");

  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (existing.includes(HOOK_MARKER)) {
      console.log("  ✓ Pre-commit hook already installed");
      return;
    }
    // Append to existing hook rather than overwrite
    const appended = existing.trimEnd() + "\n\n" + HOOK_SCRIPT;
    writeFileSync(hookPath, appended, "utf8");
    chmodSync(hookPath, 0o755);
    console.log("  ✓ argus-ci appended to existing pre-commit hook");
  } else {
    writeFileSync(hookPath, HOOK_SCRIPT, "utf8");
    chmodSync(hookPath, 0o755);
    console.log("  ✓ Pre-commit hook installed");
  }
}

// ─── Remove ───────────────────────────────────────────────────────────────────

async function removeHook(hookPath: string): Promise<void> {
  if (!existsSync(hookPath)) {
    console.log("No pre-commit hook found.");
    return;
  }

  const content = readFileSync(hookPath, "utf8");
  if (!content.includes(HOOK_MARKER)) {
    console.log("argus-ci hook not found in pre-commit hook.");
    return;
  }

  if (content.trim() === HOOK_SCRIPT.trim()) {
    const { unlinkSync } = await import("fs");
    unlinkSync(hookPath);
    console.log("✅ argus-ci pre-commit hook removed.");
    return;
  }

  const lines = content.split("\n");
  const markerIdx = lines.findIndex((l) => l.includes(HOOK_MARKER));
  if (markerIdx >= 0) {
    const stripped = lines.slice(0, markerIdx).join("\n").trimEnd() + "\n";
    writeFileSync(hookPath, stripped, "utf8");
    console.log("✅ argus-ci removed from pre-commit hook.");
  }
}
