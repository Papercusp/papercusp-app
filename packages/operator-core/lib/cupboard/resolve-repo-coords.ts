/**
 * Resolve a local git working tree's GitHub repo coordinates for a Cupboard
 * listing (revive-cupboard-distribution-2026-06-04 P1/P2). Every Cupboard
 * listing is GitHub-repo-backed — it carries `github_repository_id` /
 * `github_owner` / `github_name` / `github_url`, and the worker re-verifies the
 * repo id against the GitHub API, so the publisher MUST supply the real id.
 *
 * Both the snapshot-publish (the harness's repo) and plugin-publish (the
 * plugin's repo) bridges resolve coords the same way: read the dir's `origin`
 * remote → parse owner/repo → fetch the repo id from the GitHub API. The git +
 * GitHub calls are injected so the resolver is unit-testable.
 */
import { getGhAuthToken } from '../identity/gh-token';

export interface RepoCoords {
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
}

export interface ResolveRepoCoordsDeps {
  /** `git -C dir remote get-url origin` → the URL, or null if none / not a repo. */
  getOriginUrl: (dir: string) => Promise<string | null>;
  /** GitHub API `repos/{owner}/{repo}` → { id, html_url }, or null on failure. */
  fetchRepoMeta: (owner: string, repo: string) => Promise<{ id: number; html_url: string } | null>;
}

/** Parse a GitHub https/ssh remote into { owner, repo }. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const HTTPS_RE =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?\/?$/;
  const SSH_RE =
    /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?$/;
  const t = url.trim();
  const m = HTTPS_RE.exec(t) ?? SSH_RE.exec(t);
  if (!m) return null;
  const [, owner, repo] = m;
  return owner && repo ? { owner, repo } : null;
}

export async function resolveRepoCoordsFromDir(
  dir: string,
  deps: ResolveRepoCoordsDeps,
): Promise<RepoCoords | { error: string }> {
  const origin = await deps.getOriginUrl(dir);
  if (!origin) return { error: `no git "origin" remote in ${dir} (publishing to the Cupboard needs a GitHub-backed repo)` };
  const parsed = parseGithubRemote(origin);
  if (!parsed) return { error: `origin remote is not a GitHub repo: ${origin}` };
  const meta = await deps.fetchRepoMeta(parsed.owner, parsed.repo);
  if (!meta) return { error: `could not resolve GitHub repo ${parsed.owner}/${parsed.repo} (auth/network or private/missing)` };
  return {
    github_repository_id: meta.id,
    github_owner: parsed.owner,
    github_name: parsed.repo,
    github_url: meta.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`,
  };
}

// ─── real deps ─────────────────────────────────────────────────────────────

/** `git -C dir remote get-url origin` via spawn (no shell). */
export async function gitOriginUrl(dir: string): Promise<string | null> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

/** Fetch repo metadata from the GitHub API using the local gh-token. */
export async function fetchGithubRepoMeta(
  owner: string,
  repo: string,
): Promise<{ id: number; html_url: string } | null> {
  const tokenRes = await getGhAuthToken();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'papercusp-operator',
  };
  if (tokenRes.kind === 'ok') headers.Authorization = `Bearer ${tokenRes.token}`;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: number; html_url?: string };
    return typeof data.id === 'number' ? { id: data.id, html_url: data.html_url ?? '' } : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a repo file's raw text at `path` from the default branch via the GitHub
 * contents API (`Accept: application/vnd.github.raw`), authenticated with the
 * local gh-token like `fetchGithubRepoMeta`. Returns null when the file is
 * absent or unreadable (404, auth, network). Used by the publish-time manifest
 * gate (publish-manifest-check.ts) to verify a plugin repo is installable
 * BEFORE it is listed — EI-387 / cupboard-full-dogfood P-005.
 */
export async function fetchGithubRepoFile(
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  const tokenRes = await getGhAuthToken();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.raw',
    'User-Agent': 'papercusp-operator',
  };
  if (tokenRes.kind === 'ok') headers.Authorization = `Bearer ${tokenRes.token}`;
  // Encode each path segment but keep the `/` separators literal.
  const encPath = path.split('/').map(encodeURIComponent).join('/');
  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encPath}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
