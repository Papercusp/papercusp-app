-- 1030-repair-missing-indexes.sql
--
-- Repairs three indexes that the migrations create but that are ABSENT from the
-- live (upgraded) database, so a fresh-install schema and an upgraded schema
-- diverge. Filed as EI-21833543544960488; found by the live-vs-migration index
-- drift guard shipped in WI-918476 on its first real run (2026-08-29).
--
--   harness_shared.code_recipes_runcount_idx        created by 378 (applied 2026-06-23)
--   harness_shared.decision_ledger_ws_posture_idx   created by 260 (applied 2026-06-13)
--   harness_shared.test_runs_branch_idx             created by 000-baseline (applied 2026-06-05)
--
-- ⚠ THE ROOT CAUSE IS NOT KNOWN. This migration repairs STATE; it does not
-- remove a cause. Every candidate mechanism investigated so far is FALSIFIED
-- and recorded on EI-21833543544960488 — do not re-investigate these:
--   * "the migration file was edited after it was applied" — falsified:
--     decision_ledger_ws_posture_idx and its still-live sibling
--     decision_ledger_ws_category_idx were added in the SAME commit (8743a5c8,
--     2026-06-13T10:20Z), 25 minutes before 260 applied. They are adjacent,
--     unconditional CREATE INDEX IF NOT EXISTS statements in one transaction —
--     yet only one of the two exists live. This is the central anomaly and
--     nothing found so far explains it.
--   * runtime index-droppers — the only two DROP INDEX sites in app code
--     (db-index-bloat-reindex.ts, telemetry-retention-action.ts) and migration
--     836 are all name-scoped to %_ccnew / %_ccold; none can match these names.
--   * interrupted REINDEX CONCURRENTLY residue — live has zero _cc(new|old)
--     indexes and zero invalid indexes (verified against a 1350-index control).
--   * DROP COLUMN auto-dropping the index — no migration drops `posture` or
--     `branch`, and 378's own DROP COLUMN and its CREATE INDEX sit inside the
--     SAME conditional branch, so neither branch outcome yields an absent index.
--
-- Because the cause is open, the recurrence DETECTOR matters more than this
-- repair: the drift guard from WI-918476 makes a repeat VISIBLE instead of
-- silent. If these indexes disappear again, that guard is what will say so.
--
-- FORWARD-COMPAT: purely additive. Three CREATE INDEX IF NOT EXISTS statements
-- and nothing else — no DROP, no RENAME, no constraint or nullability change.
-- It is a no-op on a fresh install (the indexes already exist there) and cannot
-- break the older release checkout still being served by :3070, since adding an
-- index changes no relation shape and no query's results — only its plan.

-- code_recipes_runcount_idx — the GLOBAL form from 378, NOT 349's original
-- (workspace_id, hive_slug, run_count) form: 378 dropped both of those columns
-- from code_recipes and recreated the index workspace-free. Verified against
-- the live catalog — code_recipes has neither workspace_id nor hive_slug today.
CREATE INDEX IF NOT EXISTS code_recipes_runcount_idx
  ON harness_shared.code_recipes USING btree (last_run_at DESC NULLS LAST, run_count DESC);

-- decision_ledger_ws_posture_idx — verbatim from 260-decision-ledger.sql:93.
CREATE INDEX IF NOT EXISTS decision_ledger_ws_posture_idx
  ON harness_shared.decision_ledger (workspace_id, posture, ts DESC);

-- test_runs_branch_idx — verbatim from 000-baseline.sql:8640. PARTIAL index;
-- the WHERE clause is part of its identity and must be reproduced exactly, or
-- the drift guard will keep reporting a definition mismatch.
CREATE INDEX IF NOT EXISTS test_runs_branch_idx
  ON harness_shared.test_runs USING btree (branch, finished_at DESC) WHERE (branch IS NOT NULL);
