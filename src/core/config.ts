/**
 * argus-ci credential + config manager.
 *
 * Two config tiers — merged at read time (env var always wins):
 *
 *   ~/.argus-ci.json          (global, mode 0600)
 *     → credentials only: groqApiKey, anthropicApiKey, githubToken, sonarToken
 *     → set once, applies to every repo on this machine
 *     → never commit this file
 *
 *   <repo-root>/.argus-ci.json  (per-repo, committable)
 *     → project config only: sonarProjectKey, sonarServerUrl, sonarOrganization
 *     → different value per repository
 *     → safe to commit — no secrets
 *
 * Resolution priority (highest → lowest):
 *   1. Process environment variable  (CI/CD pipelines)
 *   2. Per-repo  .argus-ci.json      (project-specific settings)
 *   3. Global    ~/.argus-ci.json    (user credentials + fallback project key)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { ArgusConfig } from "../types.js";

const GLOBAL_CONFIG_PATH = join(homedir(), ".argus-ci.json");

// ─── Load helpers ─────────────────────────────────────────────────────────────

function loadFile(path: string): ArgusConfig {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")) as ArgusConfig; }
  catch { return {}; }
}

/**
 * Loads merged config for a given cwd.
 * Local (per-repo) settings override global, but tokens always come from global.
 */
export function loadConfig(cwd?: string): ArgusConfig {
  const global = loadFile(GLOBAL_CONFIG_PATH);
  if (!cwd) return global;

  const localPath = join(cwd, ".argus-ci.json");
  // Avoid re-reading global config if cwd happens to be home dir
  if (localPath === GLOBAL_CONFIG_PATH) return global;

  const local = loadFile(localPath);
  // Merge: local wins for project settings, global wins for credentials
  return { ...global, ...local };
}

/** Returns the path to the global config file */
export function getGlobalConfigPath(): string { return GLOBAL_CONFIG_PATH; }

/** Returns the path to the local per-repo config file for a given cwd */
export function getLocalConfigPath(cwd: string): string {
  return join(cwd, ".argus-ci.json");
}

// ─── Save helpers ─────────────────────────────────────────────────────────────

/** Saves credentials to global ~/.argus-ci.json (mode 0600) */
export function saveGlobalConfig(updates: Partial<ArgusConfig>): void {
  const existing = loadFile(GLOBAL_CONFIG_PATH);
  const merged   = pruneEmpty({ ...existing, ...updates });
  const dir = dirname(GLOBAL_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
}

/** Saves project-specific config to <cwd>/.argus-ci.json (safe to commit) */
export function saveLocalConfig(cwd: string, updates: Partial<ArgusConfig>): void {
  const localPath = join(cwd, ".argus-ci.json");
  const existing  = loadFile(localPath);
  const merged    = pruneEmpty({ ...existing, ...updates });
  writeFileSync(localPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

/** Backwards-compatible alias — writes to global config */
export function saveConfig(updates: Partial<ArgusConfig>): void {
  saveGlobalConfig(updates);
}

// ─── Token / setting resolvers ────────────────────────────────────────────────

/**
 * Returns true when an env var value is a template/sandbox placeholder rather
 * than a real credential.  Known offenders:
 *
 *   <SONAR_TOKEN>    ← Cursor agent sandbox injects this literal string
 *   <GITHUB_TOKEN>   ← same pattern for other tokens
 *   ${SONAR_TOKEN}   ← un-substituted shell variable
 *   $SONAR_TOKEN     ← same
 *
 * When a placeholder is detected, getCredential() falls through to
 * ~/.argus-ci.json so the real stored token is used instead.
 */
function isPlaceholder(value: string): boolean {
  if (!value || value.trim().length < 8) return true;
  const v = value.trim();
  // <TOKEN_NAME> or <tokenName>  — Cursor / CI template placeholder
  if (/^<[A-Za-z_][A-Za-z0-9_]*>$/.test(v)) return true;
  // ${VAR_NAME} or $VAR_NAME  — un-substituted shell variable
  if (/^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(v)) return true;
  // Common copy-paste boilerplate words
  if (/^(your[_-]?|replace[_-]?|enter[_-]?|insert[_-]?|add[_-]?|xxx|todo)/i.test(v)) return true;
  return false;
}

/** Credential resolution: env var → global config (never per-repo).
 *  Env var values that look like un-substituted placeholders (e.g. Cursor's
 *  <SONAR_TOKEN> sandbox injection) are silently ignored so that real tokens
 *  stored in ~/.argus-ci.json always win over them.
 */
function getCredential(envVar: string, configKey: keyof ArgusConfig): string | undefined {
  const envVal = process.env[envVar];
  if (envVal && !isPlaceholder(envVal)) return envVal;
  return loadFile(GLOBAL_CONFIG_PATH)[configKey] as string | undefined || undefined;
}

/** Project setting resolution: env var → local config → global config.
 *  Also skips placeholder env var values.
 */
function getProjectSetting(envVar: string, configKey: keyof ArgusConfig, cwd?: string): string | undefined {
  const envVal = process.env[envVar];
  if (envVal && !isPlaceholder(envVal)) return envVal;
  if (cwd) {
    const local = loadFile(join(cwd, ".argus-ci.json"))[configKey];
    if (local) return local as string;
  }
  return loadFile(GLOBAL_CONFIG_PATH)[configKey] as string | undefined || undefined;
}

// Credentials — global only
export function getGroqKey():      string | undefined { return getCredential("GROQ_API_KEY",      "groqApiKey");      }
export function getAnthropicKey(): string | undefined { return getCredential("ANTHROPIC_API_KEY", "anthropicApiKey"); }
export function getGithubToken():  string | undefined { return getCredential("GITHUB_TOKEN",      "githubToken");     }
export function getSonarToken():   string | undefined { return getCredential("SONAR_TOKEN",       "sonarToken");      }

// Project settings — per-repo preferred, global fallback
export function getSonarProjectKey(cwd?: string): string | undefined {
  return getProjectSetting("SONAR_PROJECT_KEY", "sonarProjectKey", cwd);
}
export function getSonarServerUrl(cwd?: string): string {
  return getProjectSetting("SONAR_SERVER_URL", "sonarServerUrl", cwd) ?? "https://sonarcloud.io";
}
export function getSonarOrganization(cwd?: string): string | undefined {
  return getProjectSetting("SONAR_ORGANIZATION", "sonarOrganization", cwd);
}

// ─── Status (for check_setup) ─────────────────────────────────────────────────

export function getConfigStatus(cwd?: string): ConfigStatus {
  const global    = loadFile(GLOBAL_CONFIG_PATH);
  const localPath = cwd ? join(cwd, ".argus-ci.json") : null;
  const local     = localPath && localPath !== GLOBAL_CONFIG_PATH ? loadFile(localPath) : {};

  // Use the same placeholder-aware resolution as getCredential/getProjectSetting
  // so check_setup reflects what scans will actually use.
  const realEnv = (key: string) => {
    const v = process.env[key];
    return (v && !isPlaceholder(v)) ? v : undefined;
  };

  const sonarProjectKey =
    realEnv("SONAR_PROJECT_KEY") || local.sonarProjectKey || global.sonarProjectKey;

  return {
    groq:            !!(realEnv("GROQ_API_KEY")      || global.groqApiKey),
    anthropic:       !!(realEnv("ANTHROPIC_API_KEY") || global.anthropicApiKey),
    github:          !!(realEnv("GITHUB_TOKEN")      || global.githubToken),
    sonar:           !!(realEnv("SONAR_TOKEN")       || global.sonarToken),
    sonarProject:    !!sonarProjectKey,
    sonarProjectKey: sonarProjectKey as string | undefined,
    sonarSource:     local.sonarProjectKey
      ? "local (.argus-ci.json)"
      : global.sonarProjectKey
        ? "global (~/.argus-ci.json)"
        : realEnv("SONAR_PROJECT_KEY")
          ? "env var"
          : undefined,
    globalConfigFile: existsSync(GLOBAL_CONFIG_PATH),
    localConfigFile:  localPath ? existsSync(localPath) : false,
  };
}

export interface ConfigStatus {
  groq:             boolean;
  anthropic:        boolean;
  github:           boolean;
  sonar:            boolean;
  sonarProject:     boolean;
  sonarProjectKey?: string;
  sonarSource?:     string;     // where the project key came from
  globalConfigFile: boolean;
  localConfigFile:  boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pruneEmpty(obj: Partial<ArgusConfig>): Partial<ArgusConfig> {
  const out = { ...obj };
  for (const key of Object.keys(out) as (keyof ArgusConfig)[]) {
    if (!out[key]) delete out[key];
  }
  return out;
}
