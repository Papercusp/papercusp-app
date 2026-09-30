-- 703-memory-recall-stats-per-pool.sql
--
-- context-injection-audit-2026-07-28 P-026 (I-A). The measurement instrument
-- that every other fix in that plan is measured THROUGH.
--
-- The push path (injection.ts) fans out across THREE independent pools with
-- THREE independent budgets — user (userLimit, default 6), harness
-- (PER_HARNESS_LIMIT, 3) and hive (PER_HARNESS_LIMIT, 3) — then concatenates
-- the three result sets and records ONE `hit_count`. That collapse is not a
-- cosmetic gap; it is why two separate defects stayed invisible for weeks:
--
--   * hit_count = 6 is indistinguishable between "6 user + 0 harness + 0 hive"
--     and "3 user + 3 harness". So a pool returning ZERO — e.g. because the
--     harness slug it is keyed on silently changed and nobody migrated the
--     memories — reads exactly like a healthy recall.
--   * top_score is the MAX across all three pools, so one strong personal hit
--     masks a harness pool that contributed nothing.
--
-- `pools` records the breakdown, per pool, as it was AT RECALL TIME:
--
--   {"user":    {"hits":6,"top":0.0254,"limit":6,"scopes":["u:su-be34..."]},
--    "harness": {"hits":0,"top":null,  "limit":3,"scopes":["harness:papercusp"]},
--    "hive":    {"hits":3,"top":0.0195,"limit":3,"scopes":["hive:papercusp"]}}
--
--   hits   — results this pool contributed (post score-floor, pre policy filter).
--   top    — best score WITHIN this pool (null on zero hits).
--   limit  — the per-pool budget in effect for this call. Recorded rather than
--            assumed, so `hits = limit` is a directly queryable SATURATION test
--            even after the constants are retuned (P-032/P-033 both change them,
--            and a saturation measurement that reads today's constant against
--            last week's row would silently lie).
--   scopes — the scope keys actually queried. This is the gate-2 detector: a
--            pool queried under a slug nothing writes to is otherwise
--            indistinguishable from a pool with no relevant memories.
--
-- Pull-path rows (memory:search) legitimately have no pool fan-out and record
-- `pools` as NULL — the column is nullable precisely so "single-pool read" and
-- "multi-pool read that lost its breakdown" stay distinguishable.
--
-- Also fixes a dead-column defect found while writing this: migration 290 added
-- `workspace_id` and `hive_slug`/`pot_slug` to this table, but recordRecallStats
-- was never taught to populate them — 0 of 56,841 rows carry either, so the
-- ws/pot index has never had anything to serve and no recall telemetry could be
-- sliced per workspace or pot. The writer change lands with this migration; no
-- backfill is possible (the provenance was never captured), so historical rows
-- stay NULL and any consumer must window on created_at.

ALTER TABLE harness_shared.memory_recall_stats
  ADD COLUMN IF NOT EXISTS pools jsonb;

COMMENT ON COLUMN harness_shared.memory_recall_stats.pools IS
  'Per-pool recall breakdown at recall time: {pool: {hits, top, limit, scopes}}. NULL on single-pool (pull) reads. context-injection-audit-2026-07-28 P-026.';

-- The measurements this exists to serve are all "recent rows, one pool, is it
-- saturated / did it return zero" — i.e. a created_at window with a jsonb key
-- probe. A partial index over the rows that HAVE a breakdown keeps it small
-- (pull-path rows are excluded) and lets the pool probes stay index-assisted.
CREATE INDEX IF NOT EXISTS memory_recall_stats_pools_idx
  ON harness_shared.memory_recall_stats USING gin (pools jsonb_path_ops)
  WHERE pools IS NOT NULL;
