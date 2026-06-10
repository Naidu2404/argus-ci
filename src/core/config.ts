/**
 * argus-ci credential manager.
 *
 * Stores API tokens in ~/.argus-ci.json so users only need to configure
 * them once — not per-repo or per environment variable.
 *
 * Priority order for each token (highest → lowest):
 *   1. Process environment variable (e.g. GROQ_API_KEY in CI/CD)
 *   2. ~/.argus-ci.json (set via `npx argus-ci setup --configure`)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { ArgusConfig } from "../types.js";

const CONFIG_PATH = join(homedir(), ".argus-ci.json");

// ─── Public API ───────────────────────────────────────────────────────────────

export function loadConfig(): ArgusConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ArgusConfig;
  } catch {
    return {};
  }
}

export function saveConfig(updates: Partial<ArgusConfig>): void {
  const existing = loadConfig();
  const merged = { ...existing, ...updates };
  // Remove empty/null values
  for (const key of Object.keys(merged) as (keyof ArgusConfig)[]) {
    if (!merged[key]) delete merged[key];
  }
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Resolves a token: env var takes precedence over stored config.
 * Returns undefined if neither is set.
 */
export function getToken(envVar: string, configKey: keyof ArgusConfig): string | undefined {
  return process.env[envVar] || loadConfig()[configKey] || undefined;
}

export function getGroqKey():        string | undefined { return getToken("GROQ_API_KEY",      "groqApiKey");       }
export function getAnthropicKey():   string | undefined { return getToken("ANTHROPIC_API_KEY", "anthropicApiKey");  }
export function getGithubToken():    string | undefined { return getToken("GITHUB_TOKEN",      "githubToken");      }
export function getSonarToken():     string | undefined { return getToken("SONAR_TOKEN",       "sonarToken");       }
export function getSonarProjectKey(): string | undefined {
  return process.env.SONAR_PROJECT_KEY || loadConfig().sonarProjectKey || undefined;
}
export function getSonarServerUrl(): string {
  return process.env.SONAR_SERVER_URL || loadConfig().sonarServerUrl || "https://sonarcloud.io";
}
export function getSonarOrganization(): string | undefined {
  return process.env.SONAR_ORGANIZATION || loadConfig().sonarOrganization || undefined;
}

/** Returns a summary of what's configured (for check_setup) */
export function getConfigStatus(): ConfigStatus {
  const cfg = loadConfig();
  return {
    groq:        !!(process.env.GROQ_API_KEY      || cfg.groqApiKey),
    anthropic:   !!(process.env.ANTHROPIC_API_KEY || cfg.anthropicApiKey),
    github:      !!(process.env.GITHUB_TOKEN      || cfg.githubToken),
    sonar:       !!(process.env.SONAR_TOKEN       || cfg.sonarToken),
    sonarProject:!!(process.env.SONAR_PROJECT_KEY || cfg.sonarProjectKey),
    configFile:  existsSync(CONFIG_PATH),
  };
}

export interface ConfigStatus {
  groq:         boolean;
  anthropic:    boolean;
  github:       boolean;
  sonar:        boolean;
  sonarProject: boolean;
  configFile:   boolean;
}
