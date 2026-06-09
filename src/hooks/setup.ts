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
import { platform, homedir } from "os";

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

echo "🔍 argus-ci: scanning staged files (Opengrep + Bearer if installed)..."

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

  // Step 1: ensure Opengrep (or Semgrep fallback) is installed
  await ensurePrimaryScanner();

  // Step 2: offer Bearer for deep data-flow scanning
  await ensureBearer();

  // Step 2: copy trigger files into the repo
  copyTriggerFiles(cwd);

  // Step 3: install the pre-commit hook
  installPreCommitHook(cwd);

  console.log(`
✅ Setup complete. argus-ci is now active in this repo.

  What happens next:
  • Every file your AI agent writes is scanned (Opengrep — fast, taint-aware)
  • Every commit is scanned (Opengrep + Bearer if installed) — errors block the commit
  • CLAUDE.md and .cursorrules tell your AI agent to run scans automatically

  To review a PR:     npx argus-ci pr <github-url>
  To remove the hook: npx argus-ci setup --remove
`);
}

// ─── Step 1: auto-install Opengrep (or Semgrep fallback) ─────────────────────

async function ensurePrimaryScanner(): Promise<void> {
  // Check if opengrep is already installed
  if (isScannerInstalled("opengrep")) {
    const v = getScannerVersion("opengrep");
    console.log(`  ✓ Opengrep already installed (${v})`);
    return;
  }

  // Opengrep not found — always try to install it (even if Semgrep is present),
  // because Opengrep provides free taint analysis that Semgrep community lacks.
  const semgrepPresent = isScannerInstalled("semgrep");
  if (semgrepPresent) {
    console.log("  ⚙️  Semgrep detected but Opengrep not found — installing Opengrep (free taint analysis)...");
  } else {
    console.log("  ⚙️  No scanner found — installing Opengrep (free taint analysis)...");
  }

  const installed = tryInstallOpengrep();

  if (installed) {
    const v = getScannerVersion("opengrep");
    console.log(`  ✓ Opengrep installed (${v}) — taint analysis enabled`);
    return;
  }

  // Opengrep install failed — use Semgrep if present, otherwise install it
  if (semgrepPresent) {
    const v = getScannerVersion("semgrep");
    console.log(`  ⚠️  Opengrep install failed — using existing Semgrep as fallback (${v})`);
    console.log(`     For better taint analysis, install manually: pip install opengrep`);
    return;
  }

  // Neither present — try Semgrep as fallback
  console.log("  ⚙️  Opengrep install failed — trying Semgrep as fallback...");
  const semgrepInstalled = tryInstallSemgrep();

  if (!semgrepInstalled) {
    console.error(`
  ❌ Could not install a scanner automatically.
     Please install one manually then re-run setup:

       pip install opengrep    (recommended — free taint analysis)
       brew install semgrep    (macOS, fallback)
       pip install semgrep     (any platform, fallback)
`);
    process.exit(1);
  }
  const v = getScannerVersion("semgrep");
  console.log(`  ✓ Semgrep installed as fallback (${v})`);
}

function tryInstallOpengrep(): boolean {
  const pipCmd = commandExists("pip3") ? "pip3" : "pip";

  // Strategy 1: --break-system-packages (bypasses PEP 668 on modern macOS/Linux)
  console.log(`     → ${pipCmd} install opengrep --break-system-packages`);
  const r1 = spawnSync(pipCmd, ["install", "opengrep", "--break-system-packages"], { stdio: "inherit" });
  if (r1.status === 0 && isScannerInstalled("opengrep")) return true;

  // Strategy 2: --user flag (installs to ~/.local/bin or ~/Library/Python/X.Y/bin)
  console.log(`     → ${pipCmd} install opengrep --user`);
  const r2 = spawnSync(pipCmd, ["install", "opengrep", "--user"], { stdio: "inherit" });
  if (r2.status === 0 && isScannerInstalled("opengrep")) return true;

  // Strategy 3: pipx (manages its own venv, works everywhere)
  if (commandExists("pipx")) {
    console.log("     → pipx install opengrep");
    const r3 = spawnSync("pipx", ["install", "opengrep"], { stdio: "inherit" });
    if (r3.status === 0 && isScannerInstalled("opengrep")) return true;
  }

  // Strategy 4: python3 -m pip with --break-system-packages (alternate pip entrypoint)
  const r4 = spawnSync("python3", ["-m", "pip", "install", "opengrep", "--break-system-packages"], { stdio: "inherit" });
  if (r4.status === 0 && isScannerInstalled("opengrep")) return true;

  return false;
}

function tryInstallSemgrep(): boolean {
  const os = platform();
  if (os === "darwin" && commandExists("brew")) {
    console.log("     → brew install semgrep");
    const r = spawnSync("brew", ["install", "semgrep"], { stdio: "inherit" });
    if (r.status === 0) return true;
  }
  const pipCmd = commandExists("pip3") ? "pip3" : "pip";
  console.log(`     → ${pipCmd} install semgrep`);
  const r = spawnSync(pipCmd, ["install", "semgrep"], { stdio: "inherit" });
  return r.status === 0 && isScannerInstalled("semgrep");
}

function isScannerInstalled(scanner: "opengrep" | "semgrep"): boolean {
  // Common install locations — system, Homebrew, user-local (--user flag), pipx
  const candidates = [
    scanner,
    `/usr/local/bin/${scanner}`,
    `/opt/homebrew/bin/${scanner}`,
    join(homedir(), ".local", "bin", scanner),
    join(homedir(), ".pipx", "bin", scanner),
    // macOS ~/Library/Python/X.Y/bin — check common versions
    ...["3.13", "3.12", "3.11", "3.10"].map((v) =>
      join(homedir(), "Library", "Python", v, "bin", scanner)
    ),
  ];

  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return true;
  }

  // python -m form (works even when binary not on PATH)
  const r = spawnSync("python3", ["-m", scanner, "--version"], { encoding: "utf8" });
  return r.status === 0;
}

function getScannerVersion(scanner: "opengrep" | "semgrep"): string {
  const candidates = [
    scanner,
    `/usr/local/bin/${scanner}`,
    `/opt/homebrew/bin/${scanner}`,
    join(homedir(), ".local", "bin", scanner),
    join(homedir(), ".pipx", "bin", scanner),
    ...["3.13", "3.12", "3.11", "3.10"].map((v) =>
      join(homedir(), "Library", "Python", v, "bin", scanner)
    ),
  ];

  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return r.stdout.trim().split("\n")[0];
  }

  const r = spawnSync("python3", ["-m", scanner, "--version"], { encoding: "utf8" });
  return r.stdout?.trim().split("\n")[0] ?? "unknown";
}

// ─── Step 1b: offer Bearer install ───────────────────────────────────────────

async function ensureBearer(): Promise<void> {
  // Check if Bearer already installed
  for (const cmd of ["bearer", "/usr/local/bin/bearer", "/opt/homebrew/bin/bearer"]) {
    const r = spawnSync(cmd, ["version"], { encoding: "utf8" });
    if (r.status === 0) {
      console.log(`  ✓ Bearer already installed — deep data-flow analysis enabled`);
      return;
    }
  }

  // Try to install Bearer
  console.log("  ⚙️  Installing Bearer (deep data-flow analysis)...");
  const os = platform();
  let installed = false;

  // Try curl install script first — works on macOS + Linux, no CLT requirement
  if (commandExists("curl") && (os === "darwin" || os === "linux")) {
    console.log("     → curl install script");
    const r = spawnSync(
      "sh", ["-c", "curl -sfL https://raw.githubusercontent.com/Bearer/bearer/main/contrib/install.sh | sh"],
      { stdio: "inherit" }
    );
    installed = r.status === 0;
  }

  // Fall back to brew if curl didn't work
  if (!installed && os === "darwin" && commandExists("brew")) {
    console.log("     → brew install bearer/tap/bearer");
    const r = spawnSync("brew", ["install", "bearer/tap/bearer"], { stdio: "inherit" });
    installed = r.status === 0;
  }

  if (installed) {
    console.log("  ✓ Bearer installed — staged/branch/PR scans will include data-flow analysis");
  } else {
    console.log("  ℹ️  Bearer not installed (optional) — skipping data-flow analysis");
    console.log("     Install manually: brew install bearer/tap/bearer");
  }
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
