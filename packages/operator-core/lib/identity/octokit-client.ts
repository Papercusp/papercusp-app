/**
 * octokit-client — Octokit wrapper that auths via gh-token's cache
 * and refreshes the cache on 401.
 *
 * Groundwork for Phase 1b P-068 (binding service permission checks)
 * and Phase 7 P-042 (PR poll daemon). Both need authenticated GitHub
 * calls; both benefit from the cache + auto-refresh combo.
 *
 * Design:
 *   - Single source of truth for the token: lib/identity/gh-token.
 *   - Auth is async-resolved on every request via Octokit's
 *     `auth: async () => token` shape — keeps the cache hot without
 *     a stale-token race.
 *   - On 401, error-hook invalidates the cache, retries ONCE with a
 *     fresh token, lets second-401 propagate (don't infinite-loop on
 *     genuinely revoked tokens).
 *   - Never stores the token outside gh-token's cache. The Octokit
 *     instance holds a function, not the token literal.
 *
 * Usage:
 *   ```ts
 *   const oc = await getOctokit();
 *   const { data } = await oc.users.getAuthenticated();
 *   ```
 *
 * Returns `null` when gh isn't authenticated (callers handle the
 * "user needs to run `gh auth login`" case).
 */

import { Octokit } from '@octokit/rest';
import { getGhAuthToken, refreshGhAuthToken } from './gh-token';

type SingletonCache = { __octokitClient?: Octokit | null };
const _g = globalThis as unknown as SingletonCache;

/**
 * Get a cached Octokit instance wired to gh-token. Returns null when
 * gh-token can't resolve (gh missing / not authenticated).
 */
export async function getOctokit(): Promise<Octokit | null> {
  if (_g.__octokitClient) return _g.__octokitClient;
  const initial = await getGhAuthToken();
  if (initial.kind !== 'ok') return null;
  const oc = createOctokit();
  _g.__octokitClient = oc;
  return oc;
}

/**
 * Clear the cached Octokit instance. Call when the token is known to
 * have rotated by an out-of-band path (e.g. user re-ran `gh auth
 * login` with new scopes). Most callers can rely on the 401-retry
 * hook below instead.
 */
export function clearOctokitCache(): void {
  _g.__octokitClient = null;
}

/** Default GitHub request timeout — generous enough that only a genuine hang trips it. */
const DEFAULT_GITHUB_TIMEOUT_MS = 20_000;

/** Resolve the request timeout: explicit arg → PAPERCUSP_GITHUB_TIMEOUT_MS env → default. */
export function resolveGithubTimeoutMs(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const env = Number(process.env.PAPERCUSP_GITHUB_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_GITHUB_TIMEOUT_MS;
}

/**
 * Wrap a fetch so a request that never responds is aborted after `timeoutMs`
 * (composing any caller-supplied AbortSignal). On timeout it REJECTS — which is
 * exactly what every GitHub caller's try/catch cache-fallback expects. Without
 * this, a stalled socket (captive portal, api.github.com hiccup) never resolves
 * or rejects and the await blocks forever — the root cause of the dogfood
 * hive-join freezing at 5% (resolveLocalAnnounceIdentity's GET /user + gist calls).
 *
 * Exported for tests.
 */
export function makeTimeoutFetch(timeoutMs: number, baseFetch: typeof fetch = fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new Error(`github request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const callerSignal = init?.signal ?? undefined;
    if (callerSignal) {
      const reasonOf = (s: AbortSignal) => (s as AbortSignal & { reason?: unknown }).reason;
      if (callerSignal.aborted) ctrl.abort(reasonOf(callerSignal));
      else callerSignal.addEventListener('abort', () => ctrl.abort(reasonOf(callerSignal)), { once: true });
    }
    return baseFetch(input, { ...(init ?? {}), signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }) as typeof fetch;
}

/**
 * Factory — exported for tests that want a fresh instance.
 *
 * Octokit 7+ changed the `auth:` shape (no more async-factory).
 * We use a `before('request')` hook to set the Authorization header
 * from gh-token's cache on every request — same per-request
 * resolution, just via the v7 API.
 */
export interface CreateOctokitOpts {
  /** Per-request timeout in ms. Default: PAPERCUSP_GITHUB_TIMEOUT_MS env or 20s. */
  timeoutMs?: number;
  /** Base fetch to wrap (tests inject a fake). Default: global fetch. */
  fetch?: typeof fetch;
}

export function createOctokit(opts: CreateOctokitOpts = {}): Octokit {
  // A request timeout HERE is the single app-wide guard against a hung GitHub
  // socket: every caller routes through getOctokit()/createOctokit(), and their
  // cache-fallback paths only fire on a rejection — never on a stalled await.
  const oc = new Octokit({
    request: { fetch: makeTimeoutFetch(resolveGithubTimeoutMs(opts.timeoutMs), opts.fetch) },
    // QUIET logger: octokit's request-log plugin console.error()s every failed request — redundant
    // (every caller classifies/logs its own failures) and it fails ANY vitest under fail-on-console
    // the moment GitHub is unreachable (gate-red 2026-07-01: hive/_create + identity tests died on a
    // transient network outage purely from this noise). Errors still propagate to the caller.
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });

  oc.hook.before('request', async (options) => {
    const result = await getGhAuthToken();
    if (result.kind !== 'ok') {
      throw new OctokitAuthError(
        result.error.kind === 'not_authenticated'
          ? 'gh not authenticated — run `gh auth login`'
          : result.error.kind === 'gh_cli_missing'
            ? 'gh CLI not found in PATH'
            : 'gh auth token failed: ' +
              (result.error.kind === 'gh_cli_failed' ? result.error.reason : 'unknown'),
      );
    }
    // Octokit's `EndpointOptions.headers` is a strict shape; cast
    // through `Record<string, string>` so we can spread an
    // authorization onto whatever's already there without fighting
    // the union type.
    const existing = (options.headers ?? {}) as Record<string, string>;
    options.headers = {
      ...existing,
      authorization: 'token ' + result.token,
    } as typeof options.headers;
  });

  // 401-retry: on a single 401, invalidate the cache and retry once
  // with a fresh token. Second 401 propagates — the token is
  // genuinely revoked / lacks the scope.
  oc.hook.wrap('request', async (request, options) => {
    try {
      return await request(options);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        const wasRetried = (options as { __ghTokenRetried?: boolean }).__ghTokenRetried === true;
        if (!wasRetried) {
          await refreshGhAuthToken();
          const retryOpts = { ...options, __ghTokenRetried: true };
          return request(retryOpts);
        }
      }
      throw err;
    }
  });

  return oc;
}

export class OctokitAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OctokitAuthError';
  }
}

/**
 * Detect 401 from an Octokit error. Octokit throws a `RequestError`
 * with `.status === 401`; we duck-type instead of importing the
 * type to keep the surface small.
 *
 * Exported for testing.
 */
export function isUnauthorizedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && status === 401;
}
