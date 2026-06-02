# argus-ci

**AI-powered code security agent** — catches vulnerabilities as your AI agent writes code, blocks bad commits, and reviews PRs on demand.

Powered by [Semgrep](https://semgrep.dev) under the hood. Works with Cursor, Claude Code, or any MCP-compatible editor.

---

## What it does

- **In-IDE scan** — auto-triggers after every AI code generation via MCP, surfaces issues before you even see the code
- **Pre-commit gate** — mandatory Semgrep scan on staged files before every commit; errors block the commit
- **PR / branch review** — conversational agent: type `"review PR #142"` and get a full security report
- **Zero config** — auto-detects your stack (React, Vue, Node, Python, Go…) and picks the right rulesets

Catches: injection, XSS, hardcoded secrets, insecure crypto, path traversal, prototype pollution, OWASP Top 10, and more.

---

## Requirements

- Node.js ≥ 18
- [Semgrep](https://semgrep.dev/docs/getting-started/) (`pip install semgrep` or `brew install semgrep`)
- `ANTHROPIC_API_KEY` — only needed for the conversational agent interface

---

## Install

```bash
npm install -g argus-ci
# or use without installing:
npx argus-ci
```

---

## 1. Add to your AI editor (MCP)

This is the main use case. Once added, your AI agent will automatically scan every file it writes.

**Cursor** — Settings → MCP → add:
```json
{
  "argus-ci": {
    "command": "npx",
    "args": ["argus-ci"]
  }
}
```

**Claude Code** — add to `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "argus-ci": {
      "command": "npx",
      "args": ["argus-ci"]
    }
  }
}
```

Then copy `CLAUDE.md` (or `.cursorrules`) from this package into your repo root. The AI agent will automatically call `scan_files` after every code generation.

```bash
# Copy the trigger instructions into your repo
cp node_modules/argus-ci/CLAUDE.md ./CLAUDE.md
cp node_modules/argus-ci/.cursorrules ./.cursorrules
```

### MCP tools available

| Tool | Description |
|------|-------------|
| `scan_files` | Scan specific files — called automatically after code generation |
| `scan_staged` | Scan all git-staged files |
| `scan_branch` | Scan changed files on a branch vs base |
| `scan_pr` | Scan a GitHub PR by URL, optionally post results as a comment |

---

## 2. Pre-commit hook (mandatory gate)

Installs a git hook that runs on every `git commit`. Errors block the commit. Warnings pass through.

```bash
cd your-repo
npx argus-ci setup
```

Output:
```
✅ argus-ci pre-commit hook installed.
   Using semgrep 1.x.x

The hook will:
  • Run on every git commit automatically
  • Scan only the files you're committing (fast)
  • Block the commit if any ERROR-severity issues are found
  • Allow commits with only warnings

To remove:  argus-ci setup --remove
To bypass:  git commit --no-verify  (emergency only)
```

---

## 3. Conversational agent

Review a PR or branch in plain English:

```bash
# Interactive REPL
argus-ci chat

# One-shot
argus-ci chat "review PR https://github.com/org/repo/pull/142"
argus-ci pr https://github.com/org/repo/pull/142
argus-ci scan --branch feature/auth
```

Requires `ANTHROPIC_API_KEY`:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
argus-ci chat
```

Example session:
```
You: review PR https://github.com/org/repo/pull/87

⚙️  Running scan_pr...

## Semgrep scan — PR #87: Add user authentication

| Severity | Count |
|----------|-------|
| 🔴 Error   | 2     |
| 🟡 Warning | 1     |

### `src/auth/login.ts`

**🔴 ERROR** — Line 34
> Timing attack: comparing secrets with === allows attackers to measure
> response time and guess tokens byte by byte.
`if (token === storedToken) {`
_Rule: `javascript.lang.security.audit.timing-attack`_
_CWE: CWE-208_

**Fix:** Use `crypto.timingSafeEqual(Buffer.from(token), Buffer.from(storedToken))`
```

---

## 4. CLI scan

```bash
# Scan staged files (same as what the pre-commit hook runs)
argus-ci scan

# Scan specific files
argus-ci scan src/auth/login.ts src/api/users.ts

# Scan a branch vs main
argus-ci scan --branch feature/payments

# Version
argus-ci --version
```

---

## 5. GitHub Actions (CI gate)

Add to `.github/workflows/argus-ci.yml`:

```yaml
name: Code Patrol

on:
  pull_request:
    branches: [main, develop]

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Semgrep
        run: pip install semgrep

      - name: Run argus-ci
        run: npx argus-ci scan --branch ${{ github.head_ref }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Rulesets

Auto-detected from your project. Override in any scan:

```bash
argus-ci scan --config '{"rulesets":["p/secrets","p/owasp-top-ten","p/nodejs"]}'
```

| Ruleset | When used |
|---------|-----------|
| `p/secrets` | Always — catches hardcoded API keys, tokens, passwords |
| `p/owasp-top-ten` | Always — injection, XSS, broken auth, etc. |
| `p/javascript` | Any JS project |
| `p/typescript` | TypeScript detected |
| `p/react` | React dependency found |
| `p/nodejs` | Express/Fastify/NestJS/etc. found |
| `p/nextjs` | Next.js detected |
| `p/python` | Python project |
| `p/golang` | Go project |
| `p/java` | Java/Kotlin project |

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | For chat/agent | Powers the conversational interface |
| `GITHUB_TOKEN` | For private repos | Fetch PR files, post PR comments |

---

## License

MIT © [Venkat Swara Moyya](https://github.com/venkatswaramoyya)
