/**
 * Auto-detects the tech stack from package.json / file extensions
 * and returns the appropriate Semgrep rulesets.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

interface StackInfo {
  rulesets:    string[];
  description: string;
}

export function detectRulesets(cwd: string): StackInfo {
  const rulesets = new Set<string>();

  // Always-on: secrets and OWASP top 10
  rulesets.add("p/secrets");
  rulesets.add("p/owasp-top-ten");

  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      const allDeps = {
        ...((pkg.dependencies   as Record<string, string>) ?? {}),
        ...((pkg.devDependencies as Record<string, string>) ?? {}),
      };

      // JavaScript / TypeScript — always for any JS project
      rulesets.add("p/javascript");

      // TypeScript
      if (allDeps["typescript"] || existsSync(join(cwd, "tsconfig.json"))) {
        rulesets.add("p/typescript");
      }

      // React
      if (allDeps["react"] || allDeps["react-dom"]) {
        rulesets.add("p/react");
      }

      // Vue
      if (allDeps["vue"] || allDeps["@vue/core"]) {
        rulesets.add("p/javascript"); // no official p/vue but js covers it
      }

      // Node.js server-side (Express, Fastify, Koa, NestJS etc.)
      const serverFrameworks = ["express", "fastify", "koa", "@nestjs/core", "hapi", "restify"];
      if (serverFrameworks.some((f) => f in allDeps)) {
        rulesets.add("p/nodejs");
        rulesets.add("p/sql-injection");
      }

      // Next.js
      if (allDeps["next"]) {
        rulesets.add("p/nextjs");
      }

      // Generic CI / config security
      rulesets.add("p/ci");
    } catch { /* ignore malformed package.json */ }
  }

  // Python project
  const pyFiles = ["requirements.txt", "setup.py", "pyproject.toml", "Pipfile"];
  if (pyFiles.some((f) => existsSync(join(cwd, f)))) {
    rulesets.add("p/python");
    rulesets.add("p/bandit"); // Python security
  }

  // Go
  if (existsSync(join(cwd, "go.mod"))) {
    rulesets.add("p/golang");
  }

  // Java / Kotlin
  if (existsSync(join(cwd, "pom.xml")) || existsSync(join(cwd, "build.gradle"))) {
    rulesets.add("p/java");
  }

  const list = [...rulesets];
  return {
    rulesets: list,
    description: list.join(", "),
  };
}
