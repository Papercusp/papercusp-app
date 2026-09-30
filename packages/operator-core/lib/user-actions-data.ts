/**
 * User-actions read API. Function-of-truth for both:
 *   - GET /api/user-actions/[slug] (HTTP route)
 *   - actions:recent MCP tool
 *
 * Keeps the in-memory cache + single-flight coalescing co-located so
 * both callers benefit. Transport concerns (NextRequest, X-Cache header)
 * stay in the route handler.
 */

import { getOrgPg, generated } from '@papercusp/db-org';
import { and, desc, eq, gte } from 'drizzle-orm';

const t = generated.userActionsInHarnessShared;

export interface UserActionRow {
  id: number;
  kind: string;
  status: string;
  summary: string | null;
  detailUrl: string | null;
  errorText: string | null;
  invocationId: string | null;
  startedAt: number;
  finishedAt: number | null;
  actor: string | null;
}

export interface ListUserActionsInput {
  slug: string;
  limit?: number;
  since?: number;
}

export interface ListUserActionsResult {
  actions: UserActionRow[];
  cacheStatus: 'HIT' | 'MISS' | 'COALESCED';
  cacheAgeMs: number;
}

interface DbRow {
  id: string;
  harness_slug: string;
  kind: string;
  status: string;
  summary: string | null;
  detail_url: string | null;
  error_text: string | null;
  invocation_id: string | null;
  started_at: string;
  finished_at: string | null;
  actor: string | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const CACHE_TTL_MS = 4500;

interface CacheEntry {
  ts: number;
  payload: UserActionRow[];
}

type _G = {
  __userActionsCache?: Map<string, CacheEntry>;
  __userActionsInFlight?: Map<string, Promise<UserActionRow[]>>;
};
const _g = globalThis as unknown as _G;
const cache: Map<string, CacheEntry> = _g.__userActionsCache ?? (_g.__userActionsCache = new Map());
const inflight: Map<string, Promise<UserActionRow[]>> =
  _g.__userActionsInFlight ?? (_g.__userActionsInFlight = new Map());

export class InvalidSlugError extends Error {
  constructor(slug: string) {
    super(`invalid slug: ${slug}`);
  }
}

export async function listUserActions(input: ListUserActionsInput): Promise<ListUserActionsResult> {
  if (!SLUG_RE.test(input.slug)) {
    throw new InvalidSlugError(input.slug);
  }
  const limit = Math.min(500, Math.max(1, Number(input.limit ?? 50) || 50));
  const since = Number(input.since ?? 0) || 0;

  const cacheKey = `${input.slug}:${limit}:${since}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.ts < CACHE_TTL_MS) {
    return { actions: hit.payload, cacheStatus: 'HIT', cacheAgeMs: now - hit.ts };
  }

  const existing = inflight.get(cacheKey);
  if (existing) {
    const payload = await existing;
    return { actions: payload, cacheStatus: 'COALESCED', cacheAgeMs: 0 };
  }

  const queryPromise = (async (): Promise<UserActionRow[]> => {
    const { db } = getOrgPg();
    const rows = await db
      .select({
        id: t.id,
        harness_slug: t.harnessSlug,
        kind: t.kind,
        status: t.status,
        summary: t.summary,
        detail_url: t.detailUrl,
        error_text: t.errorText,
        invocation_id: t.invocationId,
        started_at: t.startedAt,
        finished_at: t.finishedAt,
        actor: t.actor,
      })
      .from(t)
      .where(and(eq(t.harnessSlug, input.slug), gte(t.startedAt, since)))
      .orderBy(desc(t.startedAt))
      .limit(limit);
    const actions: UserActionRow[] = rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      status: r.status,
      summary: r.summary,
      detailUrl: r.detail_url,
      errorText: r.error_text,
      invocationId: r.invocation_id,
      startedAt: Number(r.started_at),
      finishedAt: r.finished_at == null ? null : Number(r.finished_at),
      actor: r.actor,
    }));
    cache.set(cacheKey, { ts: Date.now(), payload: actions });
    if (cache.size > 64) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
      if (oldest) cache.delete(oldest);
    }
    return actions;
  })();
  inflight.set(cacheKey, queryPromise);
  try {
    const payload = await queryPromise;
    return { actions: payload, cacheStatus: 'MISS', cacheAgeMs: 0 };
  } finally {
    inflight.delete(cacheKey);
  }
}
