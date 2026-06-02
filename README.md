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
- `ANTHROPIC_API_KEY` — only needed for the conversational agent (`argus-ci chat`)

> **Semgrep is installed automatically** by `npx argus-ci setup`. No manual install needed.

---

## 1. Add to your AI editor (MCP)

Open **Cursor Settings → MCP** and add:

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

The MCP server registers as **"argus"** in Cursor's tool panel.

### MCP tools available

| Tool | Description |
|------|-------------|
| `scan_files` | Scan specific files — called automatically after code generation |
| `scan_staged` | Scan all git-staged files |
| `scan_branch` | Scan changed files on a branch vs base |
| `scan_pr` | Scan a GitHub PR by URL, optionally post results as a comment |

---

## 2. Run setup in your repo

One command does everything — installs Semgrep, copies AI trigger files, and installs the pre-commit hook.

```bash
cd your-repo
npx argus-ci setup
```

Output:
```
🚀 argus-ci setup

  ⚙️  Semgrep not found — installing automatically...
     → brew install semgrep
  ✓ Semgrep installed (semgrep 1.x.x)
  ✓ CLAUDE.md written
  ✓ .cursorrules written
  ✓ Pre-commit hook installed

✅ Setup complete. argus-ci is now active in this repo.

  What happens next:
  • Every file your AI agent writes is scanned automatically (via MCP)
  • Every commit is scanned — errors block the commit
  • CLAUDE.md and .cursorrules tell your AI agent to run scans automatically

  To review a PR:     npx argus-ci pr <github-url>
  To remove the hook: npx argus-ci setup --remove
```

The setup does three things automatically:
- **Semgrep** — installed via Homebrew on macOS, pip3 elsewhere. Skipped if already installed.
- **CLAUDE.md / .cursorrules** — copied into the repo root. Tell the AI agent to call `scan_files` after every code generation.
- **Pre-commit hook** — written to `.git/hooks/pre-commit`. Blocks commits with ERROR-severity findings.

To remove: `npx argus-ci setup --remove`  
Emergency bypass: `git commit --no-verify` (not recommended)

---

## 3. Conversational agent

Review a PR or branch in plain English. Requires `ANTHROPIC_API_KEY`.

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# One-shot PR review
argus-ci pr https://github.com/org/repo/pull/142

# Interactive REPL
argus-ci chat
# You: review PR https://github.com/org/repo/pull/142
# You: check branch feature/payments
# You: what issues are in my current changes
```

---

## 4. GitHub Actions (CI gate)

Add to `.github/workflows/argus-ci.yml`:

```yaml
name: argus-ci security scan

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

Auto-detected from your project. No config needed.

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

MIT © [Venkat Swara Moyya](https://github.com/Naidu2404)
