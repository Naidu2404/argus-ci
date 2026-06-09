/**
 * Auto-detects the tech stack from package.json / file extensions
 * and returns appropriate Semgrep security + quality rulesets,
 * plus which language-specific quality linter to use.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { QualityEngine } from "../types.js";

export interface StackInfo {
  rulesets:      string[];
  description:   string;
  qualityEngine: QualityEngine | null;  // which linter to auto-install & run
  stack:         string[];              // detected stack labels for display
}

export function detectRulesets(cwd: string): StackInfo {
  const rulesets  = new Set<string>();
  const stackLabels: string[] = [];
  let qualityEngine: QualityEngine | null = null;

  // ── Always-on security ────────────────────────────────────────────────────
  rulesets.add("p/secrets");
  rulesets.add("p/owasp-top-ten");
  rulesets.add("p/security-audit");

  // ── JavaScript / TypeScript / Node / React / Vue / Next ──────────────────
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      const allDeps = {
        ...((pkg.dependencies    as Record<string, string>) ?? {}),
        ...((pkg.devDependencies as Record<string, string>) ?? {}),
      };

      stackLabels.push("JavaScript");
      qualityEngine = "oxlint"; // default quality engine for any JS project

      // Core JS quality + security
      rulesets.add("p/javascript");
      rulesets.add("p/ci");

      // TypeScript
      if (allDeps["typescript"] || existsSync(join(cwd, "tsconfig.json"))) {
        stackLabels.push("TypeScript");
        rulesets.add("p/typescript");
      }

      // React
      if (allDeps["react"] || allDeps["react-dom"]) {
        stackLabels.push("React");
        rulesets.add("p/react");
      }

      // Vue
      if (allDeps["vue"] || allDeps["@vue/core"] || allDeps["@vue/cli-service"]) {
        stackLabels.push("Vue");
        // no official p/vue ruleset — p/javascript covers Vue SFCs (script block)
      }

      // Next.js
      if (allDeps["next"]) {
        stackLabels.push("Next.js");
        rulesets.add("p/nextjs");
      }

      // Node.js server-side
      const serverFrameworks = ["express", "fastify", "koa", "@nestjs/core", "hapi", "restify"];
      if (serverFrameworks.some((f) => f in allDeps)) {
        stackLabels.push("Node.js");
        rulesets.add("p/nodejs");
        rulesets.add("p/sql-injection");
      }

    } catch { /* ignore malformed package.json */ }
  }

  // ── Python ────────────────────────────────────────────────────────────────
  const pyFiles = ["requirements.txt", "setup.py", "pyproject.toml", "Pipfile"];
  if (pyFiles.some((f) => existsSync(join(cwd, f)))) {
    stackLabels.push("Python");
    rulesets.add("p/python");
    rulesets.add("p/bandit");
    if (!qualityEngine) qualityEngine = "ruff";
  }

  // ── Go ────────────────────────────────────────────────────────────────────
  if (existsSync(join(cwd, "go.mod"))) {
    stackLabels.push("Go");
    rulesets.add("p/golang");
    if (!qualityEngine) qualityEngine = "golangci-lint";
  }

  // ── Java / Kotlin ─────────────────────────────────────────────────────────
  if (existsSync(join(cwd, "pom.xml")) || existsSync(join(cwd, "build.gradle")) ||
      existsSync(join(cwd, "build.gradle.kts"))) {
    stackLabels.push("Java");
    rulesets.add("p/java");
    if (!qualityEngine) qualityEngine = "pmd";
  }

  // ── Ruby ──────────────────────────────────────────────────────────────────
  if (existsSync(join(cwd, "Gemfile"))) {
    stackLabels.push("Ruby");
    rulesets.add("p/ruby");
    if (!qualityEngine) qualityEngine = "rubocop";
  }

  // ── PHP ───────────────────────────────────────────────────────────────────
  if (existsSync(join(cwd, "composer.json"))) {
    stackLabels.push("PHP");
    rulesets.add("p/php");
    // no dedicated quality engine for PHP yet — Semgrep covers it
  }

  // ── Rust ──────────────────────────────────────────────────────────────────
  if (existsSync(join(cwd, "Cargo.toml"))) {
    stackLabels.push("Rust");
    // Semgrep has limited Rust support; clippy is the quality tool but
    // it's built into `cargo` — skip auto-install, user has it already
  }

  const list = [...rulesets];
  return {
    rulesets:      list,
    description:   list.join(", "),
    qualityEngine,
    stack:         stackLabels.length ? stackLabels : ["Unknown"],
  };
}
