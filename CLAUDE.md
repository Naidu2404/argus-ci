# argus-ci — AI Agent Instructions

## After every code generation or modification

After you finish writing or modifying any source files, you MUST call the `scan_files` MCP tool
immediately before reporting completion to the user.

```
scan_files(files=["<list of files you just created or modified>"], cwd="<repo root>")
```

**This is mandatory — do not skip it, and do not defer it.**

The scan runs up to **6 passes in parallel** and takes 5–30 seconds depending on repo size:

| Pass | Engine | What it catches |
|------|--------|-----------------|
| 1 | Opengrep / Semgrep | OWASP Top 10, secrets, injection, XSS, eval() |
| 2 | Bearer | Multi-hop data-flow, sensitive data exposure |
| 3 | Quality linter | Oxlint / Ruff / golangci-lint — code smells, anti-patterns |
| 4 | ESLint + Prettier | Lint errors, formatting (uses repo config) |
| 5 | Dependency audit | CVEs in npm/pip/cargo deps, Dependabot alerts |
| 6 | **SonarQube/Cloud** | **Cognitive complexity, code smells, bugs, security hotspots** |

## How to present the results — always in the FIRST response

**Present ALL engines in your first scan report.** Do NOT wait for the user to ask about Sonar, deps,
or any specific pass. Every engine that ran must be surfaced upfront.

Structure your report like this every time:

```
## Scan results: `<filename>`

**Passes run:** Opengrep · Bearer · ESLint · SonarQube/Cloud · npm audit · AI enrichment

| Severity | Count |
|----------|-------|
| 🔴 Errors   | N |
| 🟡 Warnings | N |
| 🔵 Info     | N |

### 🔒 Security (Opengrep / Bearer)
[findings or "✅ No security vulnerabilities found"]

### 🔵 SonarQube/Cloud — Pass 6
[findings or "✅ No Sonar issues for this file"]
Project: <project key> · Org: <org> · Server: sonarcloud.io

### 📦 Dependencies
[findings or "✅ No vulnerable dependencies"]

### 🧹 Code quality (ESLint / Oxlint)
[findings or "✅ Clean"]

### 💡 Info / non-blocking
[list of info-level findings]
```

Even if a pass finds zero issues, **say so explicitly** (e.g. "✅ No Sonar issues"). Never silently omit an engine.

## What to do with findings

- **Error severity** → You MUST fix these before saying the task is done. Show the fix inline.
- **Warning severity** → Surface with a brief explanation. Let the user decide.
- **Info severity** → List at the end. Non-blocking, but mention them.
- **No issues** → State clearly: "All 6 passes clean — no issues found."

## Scanning PRs and branches

When the user asks to review a PR or branch, use:

- `scan_pr(pr_url="https://github.com/org/repo/pull/N")` — for PR URLs
- `scan_branch(branch="feature/xyz", base="main")` — for branch names
- `scan_staged(cwd="/repo")` — for "check my changes before I commit"
- `scan_context(cwd="/repo")` — for "scan what I'm working on" / "scan context"

## Non-negotiable rules

- Never commit or suggest committing code with unresolved ERROR-severity findings.
- Never skip the post-generation scan.
- Never tell the user to ignore scan results.
- Never present only one engine's results and leave others for follow-up — always show all 6 passes in the first report.
- If a finding is a false positive, explain why — do not silently omit it.
