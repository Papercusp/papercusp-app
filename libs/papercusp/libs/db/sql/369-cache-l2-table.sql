-- 369-cache-l2-table.sql
--
-- caching-layer-tag-eca-2026-06-22 — P-003 (the L2 = Postgres durable cache tier).
--
-- WHY: the generic @papercusp/cache lib ships an in-process L1 (LRU) behind a GenerationStore
-- seam. L1 is per-process and lost on restart; cross-process correctness + warm-after-restart
-- both need a durable second tier. This table IS that L2 — a workspace-scoped, tag-bearing
-- cache backend the host wires behind the cache seam (PgL2Store in operator-core). One row per
-- cached entry keyed by (workspace_id, cache_key); `tags` carries the entry's data dependencies
-- so an invalidate-by-tag is a single array-containment sweep, `generation` stamps the entry's
-- build generation, and `expires_at` carries the hard TTL for lazy/swept expiry.
--
-- UNLOGGED: a cache is reconstructible from source on miss, so it does NOT need WAL/crash
-- durability — UNLOGGED skips WAL for a large write-throughput win and (correctly) means the
-- table is TRUNCATEd after an unclean shutdown, which for a cache is just a cold L2 (rebuilds on
-- next miss). Ships on embedded-pg (desktop) AND native PG (server) identically.
--
-- Idempotent (IF NOT EXISTS). Additive; no rewrite of existing data. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

CREATE UNLOGGED TABLE IF NOT EXISTS harness_shared.cache_l2 (
    -- Workspace-scoped keys + tags (D-010): two workspaces can never collide.
    workspace_id text        NOT NULL,
    -- The cache key WITHIN a workspace (the lib's `key`, NOT the SEP-joined fullKey — scoping
    -- is the (workspace_id, cache_key) column pair here, not a string prefix).
    cache_key    text        NOT NULL,
    -- The cached payload (opaque JSON). NULL is a legitimately-cached negative result.
    value        jsonb,
    -- The entry's data dependencies; invalidating any one of these evicts the row. Array
    -- containment (`tags && $1`) is the tag-sweep predicate, GIN-indexed below.
    tags         text[]      NOT NULL DEFAULT '{}',
    -- The build generation stamped on the entry (monotonic per writer); lets a reader detect a
    -- racing invalidate that landed during the build (mirrors the lib's builtGen snapshot).
    generation   bigint      NOT NULL DEFAULT 0,
    -- Hard expiry (ms-precision timestamptz). NULL = no TTL. Past expiry ⇒ treated as a miss
    -- and swept (a partial-index-friendly expiry filter below).
    expires_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cache_l2_workspace_nonempty CHECK (workspace_id <> ''),
    CONSTRAINT cache_l2_key_nonempty       CHECK (cache_key <> '')
);

COMMENT ON TABLE harness_shared.cache_l2 IS
  'UNLOGGED L2 cache tier (caching-layer-tag-eca-2026-06-22 P-003) behind @papercusp/cache''s seam. One row per (workspace_id, cache_key) cached entry; tags carry the entry''s data deps for tag-sweep invalidation; expires_at is the hard TTL. UNLOGGED: a cache is reconstructible on miss, so no WAL/crash durability — truncated on unclean shutdown (a cold L2). Read/written by PgL2Store in operator-core, never directly.';

-- One row per cached key per workspace — the lookup + upsert key (get-by-key, set ON CONFLICT).
CREATE UNIQUE INDEX IF NOT EXISTS cache_l2_key_uniq
  ON harness_shared.cache_l2 (workspace_id, cache_key);

-- Tag-sweep invalidation: `WHERE workspace_id = $1 AND tags && $2`. A GIN index on the array
-- column supports the containment/overlap operator that invalidate-by-tag(s) issues.
CREATE INDEX IF NOT EXISTS cache_l2_tags_gin
  ON harness_shared.cache_l2 USING GIN (tags);

-- Expiry sweep: a periodic `DELETE … WHERE expires_at < now()`. Partial index on the rows that
-- actually carry a TTL keeps the sweep cheap and the index small (TTL-less rows never expire).
CREATE INDEX IF NOT EXISTS cache_l2_expires_idx
  ON harness_shared.cache_l2 (expires_at)
  WHERE expires_at IS NOT NULL;

COMMIT;
