/**
 * GET /api/github/search-repos?q=…&page=N — the GitHub repo-search proxy
 * (comb-hive-native-sharing-2026-06-11 P-008, D-002).
 *
 * Proxies the GitHub Search API with the operator's gh token SERVER-side —
 * the browser never holds it (same posture as the cupboard claim/admin
 * forwarders). The authed search budget is 30 req/min shared per token, so:
 *
 *   - a small in-process response cache (query+page → page, 60s TTL) absorbs
 *     repeat keystrokes / back-and-forth paging (the client debounces ~300ms
 *     on top — P-009). EPHEMERAL cache, not durable state (storage policy):
 *     it exists only to protect the shared rate budget.
 *   - rate limiting surfaces HONESTLY (D-002 "never silent empty results"):
 *     upstream 403/429 → 429 `github_rate_limited` with retryAfterSec from
 *     retry-after / x-ratelimit-reset, for the UI's "retry in Ns".
 *   - no gh login is NOT an error: the search runs unauthenticated (10
 *     req/min budget) and the response carries `authed:false` so the UI can
 *     show the sign-in nudge (D-005 / O-3 — anonymous search works).
 *
 * `auth: 'loopback'` — the desktop webview is cookie-less; the loopback bind
 * is the perimeter, same as the cupboard + discovery proxies.
 */
import { defineTool } from '@papercusp/agent-mcp';

export interface GithubRepoSearchItem {
  repoId: number;
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  /** Last push — the "recently active" signal the picker displays (P-009). */
  updatedAt: string | null;
  htmlUrl: string;
  private: boolean;
  fork: boolean;
  defaultBranch: string | null;
}

interface SearchPayload {
  ok: true;
  authed: boolean;
  totalCount: number;
  incompleteResults: boolean;
  page: number;
  perPage: number;
  items: GithubRepoSearchItem[];
}

const PER_PAGE = 20;
/** GitHub caps search at 1000 results — 50 pages of 20. */
const MAX_PAGE = 50;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 50;

// Ephemeral response cache (P-008 design): protects the 30 req/min shared
// search budget from repeat queries. FIFO-evicted, 60s TTL, successes only.
const searchCache = new Map<string, { at: number; payload: SearchPayload }>();

export function __resetGithubSearchCacheForTest(): void {
  searchCache.clear();
}

function rateLimitRetryAfterSec(upstream: Response): number {
  const retryAfter = Number(upstream.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  const resetEpochSec = Number(upstream.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(resetEpochSec) && resetEpochSec > 0) {
    return Math.max(1, Math.ceil(resetEpochSec - Date.now() / 1000));
  }
  return 60;
}

export default defineTool({
  method: 'GET',
  path: '/github/search-repos',
  auth: 'loopback',
  async handler(req) {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 256);
    if (!q) {
      return Response.json({ error: 'q required', code: 'invalid_args' }, { status: 400 });
    }
    const pageRaw = Number(url.searchParams.get('page') ?? '1');
    const page = Number.isInteger(pageRaw) ? Math.min(Math.max(pageRaw, 1), MAX_PAGE) : 1;

    const { getGhAuthToken } = await import('../../../identity/gh-token');
    const tokenRes = await getGhAuthToken();
    const authed = tokenRes.kind === 'ok';

    const cacheKey = `${authed ? 'a' : 'u'}|${page}|${q.toLowerCase()}`;
    const hit = searchCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return Response.json({ ...hit.payload, cached: true });
    }

    const upstreamUrl =
      'https://api.github.com/search/repositories?' +
      new URLSearchParams({ q, per_page: String(PER_PAGE), page: String(page) }).toString();
    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'papercusp-operator-github-search-proxy',
          ...(authed ? { Authorization: `Bearer ${tokenRes.token}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      return Response.json(
        { error: 'github_unreachable', detail: (e as Error).message.slice(0, 200) },
        { status: 502 },
      );
    }

    // The shared budget ran dry — surface it honestly with the real reset
    // (D-002: never silent empty results).
    if (upstream.status === 403 || upstream.status === 429) {
      return Response.json(
        { error: 'github_rate_limited', retryAfterSec: rateLimitRetryAfterSec(upstream), authed },
        { status: 429 },
      );
    }

    const body = (await upstream.json().catch(() => null)) as {
      total_count?: number;
      incomplete_results?: boolean;
      message?: string;
      items?: Array<{
        id?: number;
        full_name?: string;
        description?: string | null;
        stargazers_count?: number;
        language?: string | null;
        pushed_at?: string | null;
        updated_at?: string | null;
        html_url?: string;
        private?: boolean;
        fork?: boolean;
        default_branch?: string | null;
      }>;
    } | null;

    if (upstream.status === 422) {
      return Response.json(
        { error: 'invalid_query', code: 'invalid_args', detail: body?.message ?? 'unprocessable query' },
        { status: 400 },
      );
    }
    if (!upstream.ok || !body || !Array.isArray(body.items)) {
      return Response.json(
        { error: 'github_error', upstreamStatus: upstream.status, detail: body?.message?.slice(0, 200) },
        { status: 502 },
      );
    }

    const payload: SearchPayload = {
      ok: true,
      authed,
      totalCount: body.total_count ?? body.items.length,
      incompleteResults: body.incomplete_results === true,
      page,
      perPage: PER_PAGE,
      items: body.items.map((it) => ({
        repoId: it.id ?? 0,
        fullName: it.full_name ?? '',
        description: it.description ?? null,
        stars: it.stargazers_count ?? 0,
        language: it.language ?? null,
        updatedAt: it.pushed_at ?? it.updated_at ?? null,
        htmlUrl: it.html_url ?? '',
        private: it.private === true,
        fork: it.fork === true,
        defaultBranch: it.default_branch ?? null,
      })),
    };

    if (searchCache.size >= CACHE_MAX) {
      const oldest = searchCache.keys().next().value;
      if (oldest !== undefined) searchCache.delete(oldest);
    }
    searchCache.set(cacheKey, { at: Date.now(), payload });
    return Response.json(payload);
  },
});
