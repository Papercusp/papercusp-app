-- 1024: materialize is_blender_origin as a STORED generated column on harness_plans.
--
-- WHY THIS EXISTS
-- Plan index reads projected the flag inline as:
--     content LIKE '%<newline>origin: scout<newline>%' AS is_blender_origin
-- `content` averages 10 kB per row and is TOASTed (78 MB of TOAST on a 2.8 MB heap),
-- so evaluating that LIKE forces PostgreSQL to DETOAST `content` for EVERY candidate
-- row on EVERY read -- even though `content` itself is never in the result set.
--
-- MEASURED on the live database 2026-08-29 (harness_plans = 1,612 rows, 1,462 matching):
--   SELECT plan_slug ... WHERE ws/harness/archived        ->   1.4 ms,   360 buffers
--   ... + EXISTS(trigger_bindings) correlated subquery    ->   1.3 ms,   361 buffers
--   ... + content LIKE ... AS is_blender_origin           ->  88.0 ms, 7,609 buffers
-- The EXISTS subquery is free; the LIKE alone is ~98.5% of execution time and 21x
-- the buffer traffic. Those ~7,250 extra buffers are ~58 MB of TOAST per call.
--
-- SCALE (pg_stat_statements, 9.2-day window ending 2026-08-29): that read was the
-- #1 statement on the instance -- 16,449,742 calls, 89.7 ms mean, 1,475,779 s total,
-- 16.2% of ALL database execution time, ~1.86 backends saturated continuously.
-- It returns 170 rows per call and only 24 of 1,612 plans actually match the marker.
--
-- The flag is a PURE FUNCTION of `content`, so it belongs in the write path: a STORED
-- generated column computes it once per plan write instead of ~16.4M times per 9 days.
--
-- EQUIVALENCE VERIFIED against all 1,612 live rows before this migration was written:
--   current expression TRUE: 24, generated expression TRUE: 24, mismatches: 0.
--
-- DRIFT GUARD: the literal below must stay equal to BLENDER_PLAN_SQL_PATTERN in
-- packages/operator-core/lib/agent-tools/plans/plan-provenance.ts. That pairing is
-- pinned by packages/operator-core/lib/doc-claims/plan-blender-origin-column.test.ts,
-- which reads BOTH this file and the TS constant and fails the build if they diverge --
-- so changing the marker in TS cannot silently leave this column computing the old one.
--
-- Additive-only (ADD COLUMN): the currently-deployed release simply does not select it,
-- so no FORWARD-COMPAT acknowledgment is required.

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS is_blender_origin boolean
  GENERATED ALWAYS AS (content LIKE E'%\norigin: scout\n%') STORED;

COMMENT ON COLUMN harness_shared.harness_plans.is_blender_origin IS
  'Scout/Blender provenance, materialized from content. Generated STORED: do not write directly. Replaces an inline content LIKE that detoasted a 10 kB TOASTed column on every plan-index read (migration 1024).';
