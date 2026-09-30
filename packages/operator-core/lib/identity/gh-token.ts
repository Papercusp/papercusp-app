/**
 * gh-token — resolve the GitHub OAuth token via `gh auth` for use with
 * Octokit (or any HTTP layer the operator wants to call GitHub from).
 *
 * Resolves Q-4 from papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24:
 *
 *   > Can `gh auth login`-based git credentialing be reliably introspected
 *   > to get the OAuth token for `@octokit/rest`?
 *
 * Answer (measured 2026-05-24): yes. `gh auth token` runs in ~55ms on
 * Linux with the token in ~/.config/gh/hosts.yml. That's fine for
 * occasional calls (claim verification, daily re-check) but expensive
 * for sustained per-request use. The two-tier solution:
 *
 *   1. Cache the token in-memory (process-lifetime).
 *   2. Expose a refresh() hook for 401 handlers to invalidate the cache
 *      and re-read.
 *
 * The cache is per-process — desktop sidecars get their own; a Tauri
 * app + dev server running in parallel each have an independent cache.
 * That's fine: tokens don't change often, and a stale cache resolves
 * on the next 401.
 *
 * **Security**: this helper never logs the token. Callers must NOT
 * pass the token to any logging or telemetry surface. The Octokit
 * `auth:` option treats it as opaque — safe.
 *
 * **Scopes**: also exposes `getGhAuthScopes()` so callers can fail
 * fast if the user's token doesn't have the scope they need (e.g.
 * P-011 device-attestation needs `gist`; P-068 permission checks
 * need `repo`).
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Lazy promisify — import-safe in the operator-vite SPA bundle (node:util is
// browser-stubbed; a top-level promisify() call crashes at import → blank page).
// Deferred to first call; never invoked in the browser.
const execFile: (...a: unknown[]) => Promise<{ stdout: string; stderr: string }> = (...a) =>
  (promisify(_execFile) as (...x: unknown[]) => Promise<{ stdout: string; stderr: string }>)(...a);

const GH_AUTH_TOKEN_TIMEOUT_MS = 3_000;
const GH_AUTH_STATUS_TIMEOUT_MS = 5_000;

type CachedToken = {
  token: string;
  fetchedAt: number;
  githubLogin: string | null;
};

type Cache = { __ghAuthToken?: CachedToken | null };
const _g = globalThis as unknown as Cache;

export type GhTokenError =
  | { kind: 'not_authenticated' }
  | { kind: 'gh_cli_missing' }
  | { kind: 'gh_cli_failed'; reason: string };

export type GhTokenResult =
  | { kind: 'ok'; token: string }
  | { kind: 'error'; error: GhTokenError };

/**
 * Resolve the GitHub OAuth token, preferring the in-process cache.
 * On cache miss, shells out to `gh auth token` (~55ms cold).
 * On gh CLI absence or auth failure, returns a structured error;
 * never throws, never logs the token.
 */
export async function getGhAuthToken(): Promise<GhTokenResult> {
  const cached = _g.__ghAuthToken;
  if (cached && cached.token && cached.githubLogin === selectedGithubLogin()) {
    return { kind: 'ok', token: cached.token };
  }
  return refreshGhAuthToken();
}

/**
 * Invalidate the cache and re-read from `gh auth token`. Call from a
 * 401 handler after Octokit reports auth failure.
 */
export async function refreshGhAuthToken(): Promise<GhTokenResult> {
  _g.__ghAuthToken = null;
  try {
    const githubLogin = selectedGithubLogin();
    const args = ['auth', 'token'];
    if (githubLogin) args.push('--user', githubLogin);
    const { stdout } = await execFile('gh', args, {
      timeout: GH_AUTH_TOKEN_TIMEOUT_MS,
    });
    const token = stdout.trim();
    if (!token) {
      return { kind: 'error', error: { kind: 'not_authenticated' } };
    }
    _g.__ghAuthToken = { token, fetchedAt: Date.now(), githubLogin };
    return { kind: 'ok', token };
  } catch (err: unknown) {
    return { kind: 'error', error: classifyGhError(err) };
  }
}

/**
 * Select one of gh CLI's already-authenticated accounts without putting its
 * credential in this process's environment. Federation drills run multiple
 * sidecars under one OS user, so relying on gh's single active account would
 * collapse both peers onto the same identity. The login is non-secret; the gh
 * subprocess retrieves the corresponding token directly from gh's credential
 * store and the token exists only in this process's memory/cache.
 */
function selectedGithubLogin(): string | null {
  const value = process.env.PAPERCUSP_GITHUB_LOGIN?.trim();
  return value || null;
}

/**
 * Read the current token's OAuth scopes by parsing `gh auth status`.
 * Returns null on failure (cause same as getGhAuthToken). The set
 * lets callers fail fast on missing scopes — e.g. P-011 attestation
 * requires `gist`; P-068 permission checks require `repo`.
 *
 * NOT cached — scopes can change if the user re-runs `gh auth login
 * --scopes <new>`. Cheap (~50ms); call on-demand when scope matters.
 */
export async function getGhAuthScopes(): Promise<Set<string> | null> {
  try {
    const { stdout, stderr } = await execFile('gh', ['auth', 'status'], {
      timeout: GH_AUTH_STATUS_TIMEOUT_MS,
    });
    return parseScopesFromGhStatus(stdout + '\n' + stderr);
  } catch {
    return null;
  }
}

/**
 * Parse the "Token scopes:" line from `gh auth status` output.
 * Returns a Set with the scopes (without quotes). Empty set when no
 * scopes line is present.
 *
 * Exported for testing — the parse is the part worth pinning.
 */
export function parseScopesFromGhStatus(output: string): Set<string> {
  const scopes = new Set<string>();
  // `gh auth status` prints into the active-account block:
  //   "  - Token scopes: 'admin:public_key', 'gist', 'read:org', …"
  //
  // Multi-account installs may print the same line N times; collect
  // all of them so the union covers whichever account is active.
  // (Account-scope filtering is a future refinement; for now, any
  // scope visible to gh is considered usable.)
  for (const line of output.split('\n')) {
    const match = /Token scopes?:\s*(.+)$/i.exec(line);
    if (!match) continue;
    for (const raw of match[1].split(',')) {
      const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
      if (trimmed) scopes.add(trimmed);
    }
  }
  return scopes;
}

function classifyGhError(err: unknown): GhTokenError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT|not found|command not found/i.test(msg)) {
    return { kind: 'gh_cli_missing' };
  }
  if (/not.*logged.*in|no.*auth.*token|authentication.*required/i.test(msg)) {
    return { kind: 'not_authenticated' };
  }
  return { kind: 'gh_cli_failed', reason: msg };
}

/**
 * Clear the in-memory cache. Test helper + a defensive escape hatch
 * if a caller knows the token has rotated. Production code should
 * prefer refreshGhAuthToken() (which clears + re-fetches in one call).
 */
export function clearGhAuthTokenCache(): void {
  _g.__ghAuthToken = null;
}
