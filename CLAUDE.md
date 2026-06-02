# Semgrep Agent — AI Instructions

## After every code generation or modification

After you finish writing or modifying any source files, you MUST call the `scan_files` MCP tool immediately before reporting completion to the user.

```
scan_files(files=["<list of files you just created or modified"], cwd="<repo root>")
```

**This is mandatory — do not skip it.** The scan takes 2–5 seconds and catches security vulnerabilities before they reach a commit.

### What to do with the results

- **Error severity** → You MUST fix these before saying the task is done. Explain what you found and show the fix.
- **Warning severity** → Surface these to the user with a brief explanation. They should decide whether to fix now.
- **Info severity** → Mention briefly at the end. Non-blocking.
- **No issues** → Tell the user the code is clean and which rulesets passed.

### Example workflow

1. User asks you to add authentication to a route
2. You write the code
3. You call `scan_files(files=["src/auth/login.ts"], cwd="/repo")`
4. Semgrep finds a timing attack vulnerability in token comparison
5. You fix it, re-scan to confirm clean, then report done

## Scanning PRs and branches

When the user asks to review a PR or branch, use:

- `scan_pr(pr_url="https://github.com/org/repo/pull/N")` — for PR URLs
- `scan_branch(branch="feature/xyz", base="main")` — for branch names
- `scan_staged(cwd="/repo")` — for "check my changes before I commit"

## Never bypass

Do not tell the user to ignore scan results or suggest committing without fixing errors.
If a finding is a false positive, explain why — don't silently skip it.
