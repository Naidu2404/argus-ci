/**
 * GitHub API helpers.
 * Fetches changed files from a PR or branch comparison.
 *
 * Requires GITHUB_TOKEN env var for private repos (public repos work without it).
 */

interface PRFile {
  filename: string;
  status:   "added" | "modified" | "removed" | "renamed" | string;
  patch?:   string;
}

interface PRMeta {
  title:   string;
  number:  number;
  base:    string;
  head:    string;
  state:   string;
  author:  string;
  url:     string;
}

export interface PRInfo {
  meta:  PRMeta;
  files: string[];   // relative paths of changed/added files (excludes removed)
  owner: string;
  repo:  string;
}

/**
 * Parses a GitHub PR URL into owner/repo/number.
 * Accepts: https://github.com/owner/repo/pull/123
 *          github.com/owner/repo/pull/123
 */
export function parsePRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/**
 * Fetches PR metadata and list of changed files.
 */
export async function fetchPRFiles(prUrl: string, token?: string): Promise<PRInfo | null> {
  const parsed = parsePRUrl(prUrl);
  if (!parsed) return null;

  const { owner, repo, number } = parsed;
  const headers: Record<string, string> = {
    Accept:     "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const githubToken = token ?? process.env.GITHUB_TOKEN;
  if (githubToken) headers["Authorization"] = `Bearer ${githubToken}`;

  // Fetch PR metadata
  const prRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    { headers }
  );

  if (!prRes.ok) {
    if (prRes.status === 401 || prRes.status === 403) {
      throw new Error(`GitHub API auth failed — set GITHUB_TOKEN for private repos`);
    }
    if (prRes.status === 404) {
      throw new Error(`PR not found: ${prUrl}`);
    }
    throw new Error(`GitHub API error ${prRes.status}`);
  }

  const pr = await prRes.json() as {
    title: string; number: number; state: string;
    base: { ref: string }; head: { ref: string };
    user: { login: string }; html_url: string;
  };

  // Fetch changed files (paginated — GitHub caps at 300 files per PR)
  const allFiles: PRFile[] = [];
  let page = 1;
  while (true) {
    const filesRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
      { headers }
    );
    if (!filesRes.ok) break;
    const batch = await filesRes.json() as PRFile[];
    if (batch.length === 0) break;
    allFiles.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  // Only keep files that exist (not deleted)
  const files = allFiles
    .filter((f) => f.status !== "removed")
    .map((f) => f.filename);

  return {
    owner, repo,
    meta: {
      title:  pr.title,
      number: pr.number,
      base:   pr.base.ref,
      head:   pr.head.ref,
      state:  pr.state,
      author: pr.user.login,
      url:    pr.html_url,
    },
    files,
  };
}

/**
 * Posts a review comment to a PR with the scan results.
 */
export async function postPRComment(
  owner:   string,
  repo:    string,
  prNumber: number,
  body:    string,
  token?:  string
): Promise<boolean> {
  const githubToken = token ?? process.env.GITHUB_TOKEN;
  if (!githubToken) return false;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method:  "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept:        "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ body }),
    }
  );

  return res.ok;
}
