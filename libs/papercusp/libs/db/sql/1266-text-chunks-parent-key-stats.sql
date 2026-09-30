-- 1266 — expression statistics on harness_shared.text_chunks.parent_key positions
-- (generic-rag-chunking-2026-09-29 P-015, acceptance bar R-33, Decision D-031).
--
-- Every chunk-aware vector leg (chunkAwareVectorLegSql, @papercusp/search) joins a
-- chunk to its parent through `parent.<key_i> = c.parent_key[i]`. When the caller
-- filters the parent by a constant (a workspace, a harness), the planner derives
-- `c.parent_key[i] = <constant>` from the join and, with no statistics on that
-- expression, applies the default 0.005 equality selectivity per position.
--
-- MEASURED 2026-09-30 on the live operator DB (EXPLAIN ANALYZE, P-015):
--   plans leg: estimated rows=1, actual 21,257 chunks; consult leg: estimated 11,
--   actual 2,220. Believing the chunk branch returns ~1 row, the planner sorted
--   every chunk of the surface exactly instead of using the HNSW index, so the
--   work_items:search chunk branch took 151 of its 156 ms and the plans branch
--   ~190 ms, against ~2-8 ms once these statistics exist. Same-time A/B against
--   the pre-registration build: work_items:search p95 x4.5, plans:search x1.6.
--   Probe: the same legs over a copy of text_chunks, with these statistics and no
--   other change, used the HNSW index for plans and work items (top-10 overlap with
--   the exact ranking 0.967 and 0.983; consult top-1 1.000).
--
-- One statistics object per key POSITION, not per registered collection, so
-- registering a collection stays a registry entry with no DDL (R-9). Positions
-- 1..3 cover the widest registered key (plans: workspace_id, harness_slug,
-- plan_slug); text-chunks-parent-key-stats.integration.test.ts fails if a surface
-- with a wider key is registered, and fails if these objects stop correcting the
-- estimate. Autovacuum's ANALYZE maintains them from here on.
CREATE STATISTICS IF NOT EXISTS harness_shared.text_chunks_parent_key_1_stats
  ON (parent_key[1]) FROM harness_shared.text_chunks;
CREATE STATISTICS IF NOT EXISTS harness_shared.text_chunks_parent_key_2_stats
  ON (parent_key[2]) FROM harness_shared.text_chunks;
CREATE STATISTICS IF NOT EXISTS harness_shared.text_chunks_parent_key_3_stats
  ON (parent_key[3]) FROM harness_shared.text_chunks;

-- Build them now rather than at the next autovacuum ANALYZE, so the chunk legs
-- switch plans as soon as this migration commits.
ANALYZE harness_shared.text_chunks;
