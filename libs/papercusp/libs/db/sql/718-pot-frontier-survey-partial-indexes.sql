-- 718 — Partial indexes for the pot frontier survey's four hot statements (WI-6850).
--
-- WHAT THIS FIXES
-- The single largest live DB consumer: four statements from
--   packages/operator-core/lib/pot/survey.ts
-- (countPlaceableFrontier / countQuarantinedFrontier / fetchFrontierRows / the
-- checkpoint-head LATERAL) plus the escalated-issue slice that shares their
-- admission clause. Measured as a LIVE DELTA over an 8.46 min window on
-- 2026-08-02: 713.1s of 2643.0s total in-window DB time = 26.98%, each of the
-- four firing EXACTLY 1451 times in-window (~171.5 calls/min).
--
-- `harness_shared.harness_features_consolidated` is a VIEW over
-- `harness_shared.work_items` filtered to feature-family
-- (item_kind <> ALL('{bug,change,task}')). The table is 30,088 rows / 284 MB with a
-- fat `payload` jsonb + an `embedding` vector, so every heap touch detoasts.
-- Selectivity is brutal and nothing indexed it:
--     status='open'                              -> 14,715 rows
--     status='open' AND feature-family           ->    162 rows
-- Of the 27 pre-existing indexes on work_items, NONE covered (status, item_kind).
-- So the planner seq-scanned the whole table — and did it TWICE per call, because
-- the shared admission clause embeds a self-referencing
--   `SELECT DISTINCT author_pubkey FROM harness_features_consolidated ...`
-- subquery that seq-scanned the same 284 MB again (7,188 buffers, ~40 ms) purely to
-- build a 10-row pubkey set.
--
-- MEASURED (EXPLAIN ANALYZE, BUFFERS, papercusp tenant, 2026-08-02; all three
-- indexes created inside a transaction and ROLLED BACK to take the after-reading,
-- then verified absent from pg_indexes):
--
--   queryid -1220952126294647554  escalated-issue slice  132.494 ms -> 4.637 ms  (28.6x)
--   queryid -2256772142596111868  countQuarantinedFrontier 86.217 ms -> 5.033 ms  (17.1x)
--   queryid  5404439137481298558  fetchFrontierRows        58.439 ms -> 2.311 ms  (25.3x)
--   queryid -5963473354003939423  checkpoint-head LATERAL  30.292 ms -> 1.106 ms  (27.4x)
--
--   The count query in detail:
--     BEFORE  TWO Seq Scans on work_items
--             outer: Rows Removed by Filter 30,090
--             SubPlan 3 (DISTINCT author_pubkey): Rows Removed 29,781, 40.4ms
--             Buffers: shared hit=14379 (~112 MB)  |  86.217 ms  |  returns 0 rows
--     AFTER   both legs Index Scan; Rows Removed 44 and 910
--             Buffers: shared hit=1108 read=4 (1112)  |  5.033 ms
--     => 12.9x fewer buffers.
--
-- Every Seq Scan on work_items in all four plans is eliminated. Cumulative
-- pg_stat_statements cost for the four is 9,345s; at ~25x that reclaims ~8,975s.
--
-- WHY ADDING INDEXES IS OK ON A PLAN THAT HAS BEEN DROPPING THEM
-- db-performance-remediation-2026-07-26 P-002/P-003 removed 330 UNUSED indexes.
-- These three are justified by live measurement, not by guess: the statements
-- using them fire ~171x/min right now. Same reasoning as migration 717 (WI-6839).
--
-- COLUMN ORDER / PREDICATE NOTES
--  * The partial predicates are written to match the VIEW's own expansion
--    (`item_kind <> ALL (ARRAY[...])`) and the queries' literal `status='open'`,
--    so the planner can prove implication and use the partial index.
--  * work_items_escalated_open_idx keys on the SAME
--    COALESCE(payload->'_ei'->>'severity','minor') expression the escalated slice
--    filters on. Severity lives under payload._ei on the TABLE (migration 374's
--    fold) — NOT as a top-level column; see the CLAUDE.md warning about the two
--    access paths. Keying the expression is what turns that 700-of-14,553 row
--    filter into an index condition.
--
-- Idempotent: IF NOT EXISTS on every index.
-- Plan: db-performance-remediation-2026-07-26, D-016. Work item: WI-6850.

-- 1. The feature-family frontier: serves countPlaceableFrontier,
--    countQuarantinedFrontier, fetchFrontierRows and the checkpoint-head LATERAL.
CREATE INDEX IF NOT EXISTS work_items_frontier_open_idx
  ON harness_shared.work_items (workspace_id, harness_slug)
  WHERE status = 'open'
    AND item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text]);

-- 2. The shared admission clause's DISTINCT author_pubkey subquery — present in
--    ALL FOUR statements, and on its own a full 284 MB seq scan per call.
CREATE INDEX IF NOT EXISTS work_items_author_pubkey_local_idx
  ON harness_shared.work_items (workspace_id, author_pubkey)
  WHERE author_pubkey IS NOT NULL
    AND author_pubkey <> ''::text
    AND item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text]);

-- 3. The escalated-issue slice (issue-family, so the feature-family predicate
--    above deliberately does not cover it). Expression-keyed on severity.
CREATE INDEX IF NOT EXISTS work_items_escalated_open_idx
  ON harness_shared.work_items (workspace_id, (COALESCE(payload -> '_ei' ->> 'severity', 'minor')))
  WHERE status = 'open'
    AND item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text]);
