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

/** Credential resolution: env var → global config (never per-repo) */
function getCredential(envVar: string, configKey: keyof ArgusConfig): string | undefined {
  return process.env[envVar] || loadFile(GLOBAL_CONFIG_PATH)[configKey] || undefined;
}

/** Project setting resolution: env var → local config → global config */
function getProjectSetting(envVar: string, configKey: keyof ArgusConfig, cwd?: string): string | undefined {
  if (process.env[envVar]) return process.env[envVar];
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

  const sonarProjectKey =
    process.env.SONAR_PROJECT_KEY || local.sonarProjectKey || global.sonarProjectKey;

  return {
    groq:            !!(process.env.GROQ_API_KEY      || global.groqApiKey),
    anthropic:       !!(process.env.ANTHROPIC_API_KEY || global.anthropicApiKey),
    github:          !!(process.env.GITHUB_TOKEN      || global.githubToken),
    sonar:           !!(process.env.SONAR_TOKEN       || global.sonarToken),
    sonarProject:    !!sonarProjectKey,
    sonarProjectKey: sonarProjectKey as string | undefined,
    sonarSource:     local.sonarProjectKey
      ? "local (.argus-ci.json)"
      : global.sonarProjectKey
        ? "global (~/.argus-ci.json)"
        : process.env.SONAR_PROJECT_KEY
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
