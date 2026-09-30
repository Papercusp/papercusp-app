/**
 * PgL2Store — the Postgres-backed L2 tier behind the @papercusp/cache seam
 * (caching-layer-tag-eca-2026-06-22 P-003).
 *
 * The generic cache lib (`@papercusp/cache`) owns the L1 (in-process LRU) + the
 * tag-generation algorithm; it is pure and dependency-free. The durable second
 * tier — cross-process correctness + warm-after-restart — lives HERE, in
 * operator-core, because it needs `postgres`. It backs `harness_shared.cache_l2`
 * (UNLOGGED; migration 369): one row per (workspace_id, cache_key) carrying the
 * value, its data-dependency `tags`, the build `generation`, and a hard `expires_at`.
 *
 * SEAM SHAPE: the host wires L2 read-through/write-through around the lib's
 * getOrSet factory — on an L1 miss, consult `get`; on a build, `set`; on a
 * tag-invalidation, `invalidateByTags` (which the lib's invalidateByTag already
 * fans out to the in-process GenerationStore). All four mutators are ATOMIC:
 * `set` is a single upsert, `invalidateByTags` / `sweepExpired` are single
 * statements, `get` is a single SELECT that treats an expired row as a miss.
 *
 * Keys + tags are workspace-scoped (D-010): scoping is the (workspace_id,
 * cache_key) column PAIR, never a string prefix — two workspaces never collide.
 * A missing/empty workspaceId throws, mirroring the lib's cross-workspace guard.
 *
 * jsonb is bound as `${JSON.stringify(x)}::text::jsonb` on the getOrgPg org pool —
 * `sql.json()` throws and a bare object mis-binds there
 * (agent-insights/postgres-js-jsonb-binding).
 */

import { getOrgPg } from '@papercusp/db-org';

/** A durably-cached entry as stored in L2 (the value plus its invalidation metadata). */
export interface L2Entry<V = unknown> {
  value: V;
  /** Data dependencies; invalidating any one evicts this row. */
  tags: string[];
  /** Build generation stamped at write time. */
  generation: number;
  /** Hard expiry (ms epoch) or null for no TTL. */
  expiresAt: number | null;
}

export interface L2SetOptions {
  /** Data dependencies for tag-sweep invalidation. Default: none. */
  tags?: readonly string[];
  /** Build generation to stamp (monotonic per writer). Default 0. */
  generation?: number;
  /** Hard TTL in ms from now; omitted/Infinity ⇒ no expiry. */
  hardTtlMs?: number;
}

type L2Row = {
  value: unknown;
  tags: string[] | null;
  generation: string | number;
  /**
   * ⚠ `timestamptz` does NOT always arrive as a `Date` here. On the `getOrgPg` pool it
   * comes back as a STRING, so the obvious `row.expires_at.getTime()` throws
   * `row.expires_at.getTime is not a function` — see {@link toEpochMs}.
   */
  expires_at: Date | string | number | null;
};

/**
 * Coerce a `timestamptz` column to epoch ms regardless of how the driver typed it.
 *
 * This is not defensive padding — it is a fix for a bug that made the whole L2 tier
 * silently INERT (P-007, found 2026-08-08 by live-verifying on :3170). `get` threw on
 * EVERY row it actually found, so the tier degraded to a real build 100% of the time
 * and never served one hit. It read as intermittent because the throw needs a LIVE row:
 * once a row expired the query returned nothing, `get` returned undefined cleanly, and
 * the failure vanished — so the error correlated with process uptime and looked exactly
 * like a boot-time race.
 *
 * Nothing caught it earlier because the store's integration test drives a DIFFERENT
 * pg client than `getOrgPg`, and the seam's unit tests use a fake store. Only an
 * end-to-end call on a real pool surfaces it.
 */
function toEpochMs(v: Date | string | number | null): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  const ms = new Date(v).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function requireWorkspace(workspaceId: string): void {
  if (!workspaceId) throw new Error('PgL2Store: workspaceId is required (workspace-scoped keys — D-010)');
}

/**
 * The PG-backed L2 cache tier. Stateless: every method opens the shared org pool
 * via `getOrgPg()`, so a single instance is safe to share process-wide.
 */
export class PgL2Store {
  private readonly nowMs: () => number;

  constructor(opts: { clock?: () => number } = {}) {
    this.nowMs = opts.clock ?? ((): number => Date.now());
  }

  /**
   * Read the durable entry for (workspaceId, key). An expired row (expires_at in
   * the past) is treated as a MISS — returns undefined and does NOT return stale
   * data (sweeping is the separate `sweepExpired` concern). Single SELECT.
   */
  async get<V = unknown>(workspaceId: string, key: string): Promise<L2Entry<V> | undefined> {
    requireWorkspace(workspaceId);
    const { sql } = getOrgPg();
    const now = new Date(this.nowMs());
    const rows = await sql<L2Row[]>`
      SELECT value, tags, generation, expires_at
      FROM harness_shared.cache_l2
      WHERE workspace_id = ${workspaceId}
        AND cache_key = ${key}
        AND (expires_at IS NULL OR expires_at > ${now})
      LIMIT 1`;
    const row = rows[0];
    if (!row) return undefined;
    return {
      value: row.value as V,
      tags: row.tags ?? [],
      generation: Number(row.generation),
      expiresAt: toEpochMs(row.expires_at),
    };
  }

  /**
   * Durably cache `value` for (workspaceId, key) with its tags / generation /
   * TTL. Atomic upsert (ON CONFLICT) — a re-set replaces the prior entry entirely
   * so stale tags can never linger.
   */
  async set<V = unknown>(workspaceId: string, key: string, value: V, opts: L2SetOptions = {}): Promise<void> {
    requireWorkspace(workspaceId);
    if (!key) throw new Error('PgL2Store: cache key is required');
    const { sql } = getOrgPg();
    const tags = opts.tags ? [...opts.tags] : [];
    const generation = opts.generation ?? 0;
    const expiresAt =
      opts.hardTtlMs === undefined || opts.hardTtlMs === Infinity
        ? null
        : new Date(this.nowMs() + opts.hardTtlMs);
    await sql`
      INSERT INTO harness_shared.cache_l2
        (workspace_id, cache_key, value, tags, generation, expires_at, created_at)
      VALUES (
        ${workspaceId}, ${key}, ${JSON.stringify(value ?? null)}::text::jsonb,
        ${tags}, ${generation}, ${expiresAt}, now()
      )
      ON CONFLICT (workspace_id, cache_key) DO UPDATE SET
        value      = EXCLUDED.value,
        tags       = EXCLUDED.tags,
        generation = EXCLUDED.generation,
        expires_at = EXCLUDED.expires_at,
        created_at = now()`;
  }

  /** Drop the L2 entry for (workspaceId, key) regardless of its tags. Single DELETE. */
  async forget(workspaceId: string, key: string): Promise<void> {
    requireWorkspace(workspaceId);
    const { sql } = getOrgPg();
    await sql`
      DELETE FROM harness_shared.cache_l2
      WHERE workspace_id = ${workspaceId} AND cache_key = ${key}`;
  }

  /**
   * Invalidate every L2 entry in `workspaceId` carrying ANY of `tags` (array
   * overlap). Atomic single DELETE. Returns the number of rows evicted (so a
   * caller can log / meter). Empty `tags` is a no-op (never sweeps everything).
   */
  async invalidateByTags(workspaceId: string, tags: readonly string[]): Promise<number> {
    requireWorkspace(workspaceId);
    if (tags.length === 0) return 0;
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      DELETE FROM harness_shared.cache_l2
      WHERE workspace_id = ${workspaceId} AND tags && ${[...tags]}
      RETURNING 1 AS id`;
    return rows.length;
  }

  /** Convenience single-tag form of {@link invalidateByTags}. */
  invalidateByTag(workspaceId: string, tag: string): Promise<number> {
    return this.invalidateByTags(workspaceId, [tag]);
  }

  /**
   * Sweep expired rows (expires_at in the past) — the periodic janitor. Optional,
   * since `get` already treats an expired row as a miss; the sweep just reclaims
   * space. Single DELETE; returns the count reclaimed.
   */
  async sweepExpired(): Promise<number> {
    const { sql } = getOrgPg();
    const now = new Date(this.nowMs());
    const rows = await sql<{ id: number }[]>`
      DELETE FROM harness_shared.cache_l2
      WHERE expires_at IS NOT NULL AND expires_at <= ${now}
      RETURNING 1 AS id`;
    return rows.length;
  }

  /** Drop every L2 entry for a workspace (cold-bust). Single DELETE. */
  async clearWorkspace(workspaceId: string): Promise<number> {
    requireWorkspace(workspaceId);
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      DELETE FROM harness_shared.cache_l2
      WHERE workspace_id = ${workspaceId}
      RETURNING 1 AS id`;
    return rows.length;
  }
}
