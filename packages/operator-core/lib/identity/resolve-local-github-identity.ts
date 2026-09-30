/**
 * resolve-local-github-identity — resolve this machine's GitHub identity into
 * { token, githubUserId, githubLogin } for use in federation join/publish paths.
 *
 * Decision D-004 from papercusp-phase1b-bidirectional-federation-2026-06-01:
 *   The joiner's GitHub identity must be resolved SERVER-SIDE (from the local
 *   `gh` token) rather than being passed empty from the UI. This helper is the
 *   single shared resolution path used by:
 *     - The federation join endpoint (Task 2)
 *     - The binding-publish pipeline (Task 3)
 *     - local-announce-identity.ts's defaultResolveGithubUser (DRY refactor here)
 *
 * Inputs are injectable (getToken / getUser) so unit tests run without `gh` or
 * live network. Defaults wire up getGhAuthToken + getOctokit.
 */

import { getGhAuthToken } from './gh-token';
import { getOctokit } from './octokit-client';

export type LocalGithubIdentity =
  | { kind: 'ok'; token: string; githubUserId: number; githubLogin: string }
  /**
   * `transient: true` = the identity could not be resolved THIS time for a reason a
   * retry can clear (the `gh` spawn failed or timed out, or `/user` failed without an
   * auth status) — NOT evidence the machine is signed out. Absent = definitive: gh is
   * missing, not logged in, or GitHub rejected the token. `reason` says which.
   */
  | { kind: 'gh_auth_required'; transient?: true; reason?: string };

/** What a token source returns; `GhTokenResult` (the default source) is assignable to it. */
type TokenRead = { kind: string; token?: string; error?: { kind: string; reason?: string } };

export interface ResolveLocalGithubIdentityOpts {
  getToken?: () => Promise<TokenRead>;
  getUser?: () => Promise<{ id: number; login: string } | null>;
  /**
   * Test seam only: force cache participation even with injected fns. In
   * production the cache is used automatically when NO fns are injected (the
   * default path); tests inject fns and must opt in explicitly so a cached
   * value is never served across unrelated injected-mock cases.
   */
  _cache?: boolean;
}

/**
 * Cache the resolved OK identity, keyed by the current gh token
 * (whole-app-sync-payload-audit phase2 P-005). The `oc.users.getAuthenticated()`
 * GET /user round-trip inside getAuthenticatedGithubUser() was measured on the
 * read path of prReviewerSettings.byHarness (0.23s for 342B of data) and is
 * shared by ~27 callers (PR panels, claim-status, viewer, poll-daemon, …), so a
 * per-read network hop was paid all over the app. The {id, login} is machine-
 * stable; keying the cache by the token means a re-auth (which rotates the token,
 * already cached process-lifetime in gh-token with a 401-refresh hook) is a key
 * MISS → automatic invalidation, so we never serve an identity for a token that
 * is no longer current. A short TTL bounds staleness for the rare same-token
 * account edge. getToken() still runs on every call (it is cheap/cached), so
 * token freshness for federation callers is untouched — only the /user hop is
 * cached.
 */
const IDENTITY_CACHE_TTL_MS = 60_000;
let identityCache: { token: string; identity: Extract<LocalGithubIdentity, { kind: 'ok' }>; at: number } | null = null;

function errMessage(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 160);
}

/** Drop the cached identity (e.g. on a detected auth change). Also a test seam. */
export function invalidateLocalGithubIdentityCache(): void {
  identityCache = null;
}

/**
 * Shared low-level helper: resolve the authenticated GitHub user via Octokit.
 * Returns null when gh isn't authed or the `/user` response is malformed.
 * Exported so callers that already have an Octokit instance (or a mock) can
 * share the null-vs-bad-shape handling without duplicating the condition.
 */
export async function getAuthenticatedGithubUser(): Promise<{ id: number; login: string } | null> {
  const oc = await getOctokit();
  if (!oc) return null;
  const { data } = await oc.users.getAuthenticated();
  if (typeof data.id !== 'number' || typeof data.login !== 'string' || !data.login) return null;
  return { id: data.id, login: data.login };
}

/**
 * Resolve the local machine's GitHub identity.
 *
 * Returns `{ kind: 'ok', token, githubUserId, githubLogin }` when both the gh
 * token and the `/user` call succeed.
 * Returns `{ kind: 'gh_auth_required', reason }` when gh isn't authenticated or the
 * user can't be resolved — never throws. `transient: true` marks the failures a retry
 * can clear (gh failed to run, or `/user` got no real answer).
 */
export async function resolveLocalGithubIdentity(
  opts: ResolveLocalGithubIdentityOpts = {},
): Promise<LocalGithubIdentity> {
  const getToken: () => Promise<TokenRead> = opts.getToken ?? getGhAuthToken;
  const getUser = opts.getUser ?? getAuthenticatedGithubUser;
  // Cache participates on the default (production) path; injected-mock tests opt
  // in explicitly via `_cache` so no cached value crosses unrelated cases.
  const useCache = opts._cache ?? (!opts.getToken && !opts.getUser);

  let tok: TokenRead;
  try {
    tok = await getToken();
  } catch (e) {
    return { kind: 'gh_auth_required', transient: true, reason: `gh token read threw: ${errMessage(e)}` };
  }
  if (tok.kind !== 'ok' || !tok.token) {
    // A `gh` that ran and said "not logged in" (or is not installed) is definitive; one
    // that failed to RUN — a spawn timeout on a starved first boot is the measured case
    // (P-007 run #13, Mac VM) — says nothing about sign-in, so a retry may clear it.
    if (tok.error?.kind === 'gh_cli_failed') {
      return { kind: 'gh_auth_required', transient: true, reason: `gh auth token failed: ${tok.error.reason ?? 'unknown'}` };
    }
    return { kind: 'gh_auth_required', reason: tok.error?.kind ?? 'no gh token' };
  }

  // Serve the cached identity for this exact token within the TTL — skips the
  // GET /user network hop. A rotated token (re-auth) is a key miss.
  if (useCache && identityCache && identityCache.token === tok.token && Date.now() - identityCache.at < IDENTITY_CACHE_TTL_MS) {
    return identityCache.identity;
  }

  let user: { id: number; login: string } | null;
  try {
    user = await getUser();
  } catch (e) {
    // GitHub answering 401/403 rejects the token; anything else (no status, 5xx: the
    // request never got a real answer) is a network failure a retry can clear.
    const status = (e as { status?: unknown })?.status;
    if (status === 401 || status === 403) {
      return { kind: 'gh_auth_required', reason: `GitHub rejected the token (${status})` };
    }
    return { kind: 'gh_auth_required', transient: true, reason: `GET /user failed: ${errMessage(e)}` };
  }
  if (!user) return { kind: 'gh_auth_required', reason: 'GET /user returned no user' };
  const identity = { kind: 'ok' as const, token: tok.token, githubUserId: user.id, githubLogin: user.login };
  if (useCache) identityCache = { token: tok.token, identity, at: Date.now() };
  return identity;
}
