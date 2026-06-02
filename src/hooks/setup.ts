/**
 * Pre-commit hook installer.
 * Writes a git hook that runs `argus-ci scan --staged`
 * and blocks the commit if any ERROR-severity findings are found.
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "fs";
import { join } from "path";

const HOOK_MARKER = "# argus-ci-hook";

const HOOK_SCRIPT = `#!/usr/bin/env sh
${HOOK_MARKER}
# Semgrep quality gate — runs on every commit.
# Remove with: argus-ci setup --remove
# Bypass (emergency only): git commit --no-verify

echo "🔍 Running Semgrep security scan on staged files..."

# Run argus-ci scan on staged files
# Exit code 1 = errors found → block commit
# Exit code 0 = clean → allow commit
npx --yes argus-ci scan --staged

EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo "❌ Semgrep found security issues — commit blocked."
  echo "   Fix the issues above, then run: git commit"
  echo "   To skip (not recommended): git commit --no-verify"
  exit 1
fi

echo "✅ Semgrep scan passed."
exit 0
`;

export async function setupHook(cwd: string): Promise<void> {
  const remove = process.argv.includes("--remove");

  // Find .git directory
  const gitDir = join(cwd, ".git");
  if (!existsSync(gitDir)) {
    console.error("❌ Not a git repository. Run this from the repo root.");
    process.exit(1);
  }

  const hooksDir  = join(gitDir, "hooks");
  const hookPath  = join(hooksDir, "pre-commit");

  if (remove) {
    await removeHook(hookPath);
    return;
  }

  // Create hooks dir if needed
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  // Check if a hook already exists (not ours)
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");

    if (existing.includes(HOOK_MARKER)) {
      console.log("✅ argus-ci pre-commit hook already installed.");
      return;
    }

    // Append to existing hook
    const appended = existing.trimEnd() + "\n\n" + HOOK_SCRIPT;
    writeFileSync(hookPath, appended, "utf8");
    chmodSync(hookPath, 0o755);
    console.log("✅ argus-ci hook appended to existing pre-commit hook.");
  } else {
    writeFileSync(hookPath, HOOK_SCRIPT, "utf8");
    chmodSync(hookPath, 0o755);
    console.log("✅ argus-ci pre-commit hook installed.");
  }

  // Verify semgrep is available
  const { spawnSync } = await import("child_process");
  const check = spawnSync("semgrep", ["--version"], { encoding: "utf8" });
  if (check.status !== 0) {
    console.log("\n⚠️  semgrep not found on PATH.");
    console.log("   Install it before the hook will work:");
    console.log("   → pip install semgrep");
    console.log("   → brew install semgrep\n");
  } else {
    const version = check.stdout.trim();
    console.log(`   Using semgrep ${version}`);
  }

  console.log("\nThe hook will:");
  console.log("  • Run on every git commit automatically");
  console.log("  • Scan only the files you're committing (fast)");
  console.log("  • Block the commit if any ERROR-severity issues are found");
  console.log("  • Allow commits with only warnings");
  console.log("\nTo remove:  argus-ci setup --remove");
  console.log("To bypass:  git commit --no-verify  (emergency only)\n");
}

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

  // If the entire file is our hook, delete it
  if (content.trim() === HOOK_SCRIPT.trim()) {
    const { unlinkSync } = await import("fs");
    unlinkSync(hookPath);
    console.log("✅ argus-ci pre-commit hook removed.");
    return;
  }

  // Otherwise strip our section from the file
  const lines = content.split("\n");
  const markerIdx = lines.findIndex((l) => l.includes(HOOK_MARKER));
  if (markerIdx > 0) {
    const stripped = lines.slice(0, markerIdx).join("\n").trimEnd() + "\n";
    writeFileSync(hookPath, stripped, "utf8");
    console.log("✅ argus-ci section removed from pre-commit hook.");
  }
}
