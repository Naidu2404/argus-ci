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
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { platform, homedir } from "os";
import { detectRulesets } from "../core/detector.js";
import { loadConfig, saveGlobalConfig, saveLocalConfig, getGlobalConfigPath } from "../core/config.js";
import type { QualityEngine } from "../types.js";

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
  const remove    = process.argv.includes("--remove");
  const configure = process.argv.includes("--configure");

  if (remove) {
    const hookPath = join(cwd, ".git", "hooks", "pre-commit");
    await removeHook(hookPath);
    return;
  }

  if (configure) {
    await runConfigureWizard(cwd);
    return;
  }

  console.log("\n🚀 argus-ci setup\n");

  // Detect stack upfront so we can show what we're setting up
  const stackInfo = detectRulesets(cwd);
  console.log(`  Detected stack: ${stackInfo.stack.join(", ")}\n`);

  // Step 1: ensure Opengrep (or Semgrep fallback) is installed
  await ensurePrimaryScanner();

  // Step 2: Bearer for deep data-flow security analysis
  await ensureBearer();

  // Step 3: language-specific quality linter
  await ensureQualityEngine(stackInfo.qualityEngine);

  // Step 4: copy trigger files into the repo
  copyTriggerFiles(cwd);

  // Step 5: install the pre-commit hook
  installPreCommitHook(cwd);

  const qualityNote = stackInfo.qualityEngine
    ? `Opengrep + Bearer + ${stackInfo.qualityEngine}`
    : "Opengrep + Bearer";

  console.log(`
✅ Setup complete. argus-ci is now active in this repo.

  What happens next:
  • Every file your AI agent writes is scanned (Opengrep — fast, taint-aware)
  • Every commit is scanned (${qualityNote}) — errors block the commit
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
  // Opengrep is NOT on PyPI — install via the official install script (like Bearer).
  // It installs to ~/.opengrep/cli/latest/opengrep
  if (!commandExists("curl")) {
    console.log("     ℹ️  curl not found — cannot download Opengrep");
    return false;
  }

  console.log("     → curl -fsSL https://raw.githubusercontent.com/opengrep/opengrep/main/install.sh | bash");
  const r = spawnSync(
    "bash",
    ["-c", "curl -fsSL https://raw.githubusercontent.com/opengrep/opengrep/main/install.sh | bash"],
    { stdio: "inherit" }
  );

  return r.status === 0 && isScannerInstalled("opengrep");
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

function opengrepPaths(): string[] {
  // Official install script puts binary at ~/.opengrep/cli/latest/opengrep
  // Also check ~/.opengrep/bin/opengrep as a fallback path
  return [
    join(homedir(), ".opengrep", "cli", "latest", "opengrep"),
    join(homedir(), ".opengrep", "bin", "opengrep"),
    join(homedir(), ".opengrep", "opengrep"),
  ];
}

function isScannerInstalled(scanner: "opengrep" | "semgrep"): boolean {
  const candidates = [
    scanner,
    `/usr/local/bin/${scanner}`,
    `/opt/homebrew/bin/${scanner}`,
    join(homedir(), ".local", "bin", scanner),
    ...(scanner === "opengrep" ? opengrepPaths() : []),
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
    ...(scanner === "opengrep" ? opengrepPaths() : []),
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

// ─── Step 3: auto-install language quality linter ────────────────────────────

async function ensureQualityEngine(engine: QualityEngine | null): Promise<void> {
  if (!engine) {
    console.log("  ℹ️  No quality linter for this stack — skipping");
    return;
  }

  const label = QUALITY_ENGINE_LABELS[engine];

  // Check if already installed
  if (isQualityEnginePresent(engine)) {
    console.log(`  ✓ ${label} already installed — code quality analysis enabled`);
    return;
  }

  console.log(`  ⚙️  Installing ${label} (code quality linter)...`);
  const installed = tryInstallQualityEngine(engine);

  if (installed) {
    console.log(`  ✓ ${label} installed — commits will include quality checks`);
  } else {
    console.log(`  ℹ️  ${label} not installed (optional) — quality checks skipped`);
    console.log(`     Install manually: ${QUALITY_ENGINE_INSTALL_HINT[engine]}`);
  }
}

const QUALITY_ENGINE_LABELS: Record<QualityEngine, string> = {
  "oxlint":        "Oxlint (JS/TS quality)",
  "ruff":          "Ruff (Python quality)",
  "golangci-lint": "golangci-lint (Go quality)",
  "rubocop":       "RuboCop (Ruby quality)",
  "pmd":           "PMD (Java quality)",
  "phpstan":       "PHPStan (PHP static analysis)",
};

const QUALITY_ENGINE_INSTALL_HINT: Record<QualityEngine, string> = {
  "oxlint":        "npm install -g oxlint",
  "ruff":          "pip install ruff  OR  brew install ruff",
  "golangci-lint": "brew install golangci-lint  OR  curl -sfL https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/install.sh | sh",
  "rubocop":       "gem install rubocop",
  "pmd":           "brew install pmd",
  "phpstan":       "composer global require phpstan/phpstan  OR  curl -sL https://github.com/phpstan/phpstan/releases/latest/download/phpstan.phar -o ~/.local/bin/phpstan && chmod +x ~/.local/bin/phpstan",
};

function isQualityEnginePresent(engine: QualityEngine): boolean {
  const candidates = qualityEngineCandidates(engine);
  const versionArg = engine === "golangci-lint" ? "--version" : "--version";
  for (const cmd of candidates) {
    const r = spawnSync(cmd, [versionArg], { encoding: "utf8" });
    if (r.status === 0) return true;
  }
  return false;
}

function qualityEngineCandidates(engine: QualityEngine): string[] {
  const home = homedir();
  switch (engine) {
    case "oxlint":
      return ["oxlint", "/usr/local/bin/oxlint", "/opt/homebrew/bin/oxlint",
              join(home, ".local", "bin", "oxlint"), join(home, ".npm-global", "bin", "oxlint")];
    case "ruff":
      return ["ruff", "/usr/local/bin/ruff", "/opt/homebrew/bin/ruff",
              join(home, ".local", "bin", "ruff"), join(home, ".cargo", "bin", "ruff")];
    case "golangci-lint":
      return ["golangci-lint", "/usr/local/bin/golangci-lint", "/opt/homebrew/bin/golangci-lint",
              join(home, "go", "bin", "golangci-lint")];
    case "rubocop":
      return ["rubocop", "/usr/local/bin/rubocop", join(home, ".rbenv", "shims", "rubocop")];
    case "pmd":
      return ["pmd", "/usr/local/bin/pmd", "/opt/homebrew/bin/pmd"];
    case "phpstan":
      return [
        "phpstan",
        "/usr/local/bin/phpstan",
        "/opt/homebrew/bin/phpstan",
        join(home, ".composer", "vendor", "bin", "phpstan"),
        join(home, ".config", "composer", "vendor", "bin", "phpstan"),
        join(home, ".local", "bin", "phpstan"),
      ];
  }
}

function tryInstallQualityEngine(engine: QualityEngine): boolean {
  const os = platform();

  switch (engine) {
    case "oxlint": {
      // npm install -g oxlint (works on any OS with Node)
      if (commandExists("npm")) {
        console.log("     → npm install -g oxlint");
        const r = spawnSync("npm", ["install", "-g", "oxlint"], { stdio: "inherit" });
        if (r.status === 0 && isQualityEnginePresent("oxlint")) return true;
      }
      // npx as fallback — oxlint can run via npx without global install
      console.log("     ℹ️  Will run via npx oxlint (no global install needed)");
      return false; // npx handled at runtime in quality.ts
    }

    case "ruff": {
      // brew on macOS (fastest)
      if (os === "darwin" && commandExists("brew")) {
        console.log("     → brew install ruff");
        const r = spawnSync("brew", ["install", "ruff"], { stdio: "inherit" });
        if (r.status === 0 && isQualityEnginePresent("ruff")) return true;
      }
      // pip with --break-system-packages
      const pipCmd = commandExists("pip3") ? "pip3" : "pip";
      console.log(`     → ${pipCmd} install ruff --break-system-packages`);
      const r2 = spawnSync(pipCmd, ["install", "ruff", "--break-system-packages"], { stdio: "inherit" });
      if (r2.status === 0 && isQualityEnginePresent("ruff")) return true;
      // pipx fallback
      if (commandExists("pipx")) {
        const r3 = spawnSync("pipx", ["install", "ruff"], { stdio: "inherit" });
        if (r3.status === 0 && isQualityEnginePresent("ruff")) return true;
      }
      return false;
    }

    case "golangci-lint": {
      if (os === "darwin" && commandExists("brew")) {
        console.log("     → brew install golangci-lint");
        const r = spawnSync("brew", ["install", "golangci-lint"], { stdio: "inherit" });
        if (r.status === 0) return true;
      }
      if (commandExists("curl")) {
        console.log("     → curl install script");
        const r = spawnSync(
          "sh", ["-c", "curl -sfL https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/install.sh | sh -s -- -b $(go env GOPATH)/bin"],
          { stdio: "inherit" }
        );
        if (r.status === 0 && isQualityEnginePresent("golangci-lint")) return true;
      }
      return false;
    }

    case "rubocop": {
      if (commandExists("gem")) {
        console.log("     → gem install rubocop");
        const r = spawnSync("gem", ["install", "rubocop"], { stdio: "inherit" });
        if (r.status === 0 && isQualityEnginePresent("rubocop")) return true;
      }
      return false;
    }

    case "pmd": {
      if (os === "darwin" && commandExists("brew")) {
        console.log("     → brew install pmd");
        const r = spawnSync("brew", ["install", "pmd"], { stdio: "inherit" });
        if (r.status === 0 && isQualityEnginePresent("pmd")) return true;
      }
      return false;
    }

    case "phpstan": {
      const localBin = join(homedir(), ".local", "bin");

      // Option 1: composer global require (best — keeps phpstan in vendor)
      if (commandExists("composer")) {
        console.log("     → composer global require phpstan/phpstan");
        const r = spawnSync("composer", ["global", "require", "phpstan/phpstan", "--no-interaction"], {
          stdio: "inherit",
        });
        if (r.status === 0 && isQualityEnginePresent("phpstan")) return true;
      }

      // Option 2: Download the phpstan.phar directly (no composer required)
      if (commandExists("curl")) {
        try {
          mkdirSync(localBin, { recursive: true });
          const dest = join(localBin, "phpstan");
          console.log(`     → curl https://github.com/phpstan/phpstan/releases/latest/download/phpstan.phar`);
          const r = spawnSync(
            "bash",
            ["-c", `curl -sL https://github.com/phpstan/phpstan/releases/latest/download/phpstan.phar -o "${dest}" && chmod +x "${dest}"`],
            { stdio: "inherit" }
          );
          if (r.status === 0 && isQualityEnginePresent("phpstan")) return true;
        } catch { /* ignore */ }
      }

      return false;
    }
  }
}

// ─── Step 4: copy trigger files ───────────────────────────────────────────────

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

// ─── Credential wizard ────────────────────────────────────────────────────────

async function runConfigureWizard(cwd: string): Promise<void> {
  console.log("\n🔑 argus-ci configure\n");

  // Show which repo we're in
  const inRepo = existsSync(join(cwd, ".git"));
  const repoName = cwd.split("/").pop() ?? cwd;

  console.log("Two config tiers:");
  console.log(`  🌐 Global   ~/.argus-ci.json          — credentials (SONAR_TOKEN, GROQ_API_KEY, GITHUB_TOKEN)`);
  console.log(`  📁 Per-repo ./.argus-ci.json           — project settings (SONAR_PROJECT_KEY)`);
  console.log(`             applies to: ${inRepo ? repoName : "(not a git repo — will still save global)"}`);
  console.log(`\nPress Enter to keep the existing value. Tokens are masked.\n`);

  const globalCfg = loadConfig();          // global only
  const localCfg  = loadConfig(cwd);      // merged (local overrides global)

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string, current?: string): Promise<string> =>
    new Promise((resolve) => {
      const hint = current ? ` (current: ${maskToken(current)})` : "";
      rl.question(`  ${question}${hint}: `, (ans) => resolve(ans.trim()));
    });

  // ── GLOBAL: Groq API key ──────────────────────────────────────────────────
  console.log("──────────────────────────────────────────────────────────────");
  console.log("🌐 GLOBAL credentials (saved to ~/.argus-ci.json)");
  console.log("──────────────────────────────────────────────────────────────\n");

  console.log("  GROQ_API_KEY — AI fix suggestions on every error (free)");
  console.log("  Get one at: https://console.groq.com → API Keys → Create key\n");
  const groqKey = await ask("GROQ_API_KEY", globalCfg.groqApiKey);
  if (groqKey) {
    process.stdout.write("  Validating... ");
    console.log(await validateGroqKey(groqKey) ? "✅ valid" : "⚠️  could not validate (saved anyway)");
  }

  // ── GLOBAL: GitHub token ──────────────────────────────────────────────────
  console.log("\n  GITHUB_TOKEN — Dependabot vulnerability alerts (Pass 5)");
  console.log("  Get one at: https://github.com/settings/tokens");
  console.log("  Scope needed: 'Dependabot alerts: Read' (fine-grained) or 'security_events' (classic)\n");
  const githubToken = await ask("GITHUB_TOKEN", globalCfg.githubToken);
  if (githubToken) {
    process.stdout.write("  Validating... ");
    console.log(await validateGithubToken(githubToken) ? "✅ valid" : "⚠️  could not validate (saved anyway)");
  }

  // ── GLOBAL: Sonar token ───────────────────────────────────────────────────
  console.log("\n  SONAR_TOKEN — SonarQube/Cloud issues (Pass 6)");
  console.log("  SonarCloud: https://sonarcloud.io/account/security → Generate token");
  console.log("  SonarQube:  https://<your-server>/account/security → Generate token\n");
  const sonarToken = await ask("SONAR_TOKEN", globalCfg.sonarToken);

  // ── PER-REPO: Sonar project settings ─────────────────────────────────────
  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`📁 PER-REPO settings (saved to .argus-ci.json in ${repoName})`);
  console.log("   Different repos → different project keys. Safe to commit.");
  console.log("──────────────────────────────────────────────────────────────\n");

  // Show where current project key is coming from
  const currentProjectKey  = localCfg.sonarProjectKey;
  const currentServerUrl   = localCfg.sonarServerUrl;
  const currentOrg         = localCfg.sonarOrganization;

  console.log("  SONAR_PROJECT_KEY — the project key in your Sonar dashboard");
  console.log("  Find it: SonarCloud project → Administration → Project Key\n");
  const sonarProjectKey = await ask("SONAR_PROJECT_KEY", currentProjectKey);
  const sonarServerUrl  = await ask("SONAR_SERVER_URL  (blank = SonarCloud)", currentServerUrl);
  const sonarOrg        = await ask("SONAR_ORGANIZATION (SonarCloud org slug, blank = self-hosted)", currentOrg);

  // Validate Sonar if both token and key provided
  if ((sonarToken || globalCfg.sonarToken) && sonarProjectKey) {
    process.stdout.write("\n  Validating Sonar connection... ");
    const tokenToTest   = sonarToken || globalCfg.sonarToken!;
    const serverToTest  = sonarServerUrl || currentServerUrl || "https://sonarcloud.io";
    const orgToTest     = sonarOrg || currentOrg;
    const valid = await validateSonarToken(tokenToTest, sonarProjectKey, serverToTest, orgToTest);
    console.log(valid ? "✅ valid" : "⚠️  could not validate — check project key and organization");
  }

  rl.close();

  // ── Save credentials → GLOBAL ~/.argus-ci.json ────────────────────────────
  const globalUpdates: Record<string, string> = {};
  if (groqKey)      globalUpdates["groqApiKey"]   = groqKey;
  if (githubToken)  globalUpdates["githubToken"]  = githubToken;
  if (sonarToken)   globalUpdates["sonarToken"]   = sonarToken;

  if (Object.keys(globalUpdates).length > 0) {
    saveGlobalConfig(globalUpdates);
    console.log(`\n  ✅ Credentials saved → ${getGlobalConfigPath()}`);
  }

  // ── Save project settings → LOCAL .argus-ci.json ─────────────────────────
  const localUpdates: Record<string, string> = {};
  if (sonarProjectKey) localUpdates["sonarProjectKey"]  = sonarProjectKey;
  if (sonarServerUrl)  localUpdates["sonarServerUrl"]   = sonarServerUrl;
  if (sonarOrg)        localUpdates["sonarOrganization"] = sonarOrg;

  if (Object.keys(localUpdates).length > 0) {
    saveLocalConfig(cwd, localUpdates);
    console.log(`  ✅ Project config saved → ${join(cwd, ".argus-ci.json")}`);
    console.log(`     (commit this file — it has no secrets, only project settings)`);
  }

  // Summary
  console.log(`
Passes now active:
  ${(groqKey || globalCfg.groqApiKey)   ? "✅" : "❌"} AI fix suggestions (+AI)     ${!groqKey && !globalCfg.groqApiKey ? "— add GROQ_API_KEY to enable" : ""}
  ${(githubToken || globalCfg.githubToken) ? "✅" : "❌"} Dependabot alerts (Pass 5)  ${!githubToken && !globalCfg.githubToken ? "— add GITHUB_TOKEN to enable" : ""}
  ${(sonarToken || globalCfg.sonarToken) && sonarProjectKey ? "✅" : "❌"} SonarQube/Cloud (Pass 6)    ${!(sonarToken || globalCfg.sonarToken) ? "— add SONAR_TOKEN to enable" : !sonarProjectKey ? "— add SONAR_PROJECT_KEY to enable" : ""}

Run \`npx argus-ci check_setup\` to verify.
`);
}

function maskToken(token: string): string {
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

async function validateGroqKey(key: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    return res.ok;
  } catch { return false; }
}

async function validateGithubToken(token: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    return res.ok;
  } catch { return false; }
}

async function validateSonarToken(
  token: string, projectKey: string, serverUrl: string, org?: string
): Promise<boolean> {
  try {
    const params = new URLSearchParams({ componentKeys: projectKey, ps: "1" });
    if (org) params.set("organization", org);
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/api/issues/search?${params}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}` },
    });
    return res.ok;
  } catch { return false; }
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
