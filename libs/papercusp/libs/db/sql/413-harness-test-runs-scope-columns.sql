-- 413-harness-test-runs-scope-columns.sql
--
-- enforce-system-on-generic-work-2026-06-29 P-007 + P-020 — the scoping half of
-- the TEST-TAB INGESTION PIPELINE. Today harness_shared.test_runs is written
-- only by the operator/dogfood vitest reporter, so a MANAGED harness's Tests
-- tab (fetchHistory) has nothing to show. To let EVERY managed hive surface its
-- framework-test history in its OWN Tests tab, each row needs per-hive scope
-- keys:
--
--   harness_slug  — which harness/hive the run belongs to. NULL = a legacy
--                   dogfood/admin-ui row written before this column existed.
--   workspace_id  — the writing workspace. NULL = a legacy row.
--
-- The harness run route (packages/operator-core/lib/endpoint-route/routes/
-- harness/testing.ts) stamps both on every per-file row it ingests; the per-hive
-- file-history route filters WHERE harness_slug = $slug AND workspace_id = $ws
-- AND file_path = $f. So tests show up in a hive's tab from day one with NO
-- per-repo scaffolding and NO backfill (P-020).
--
-- SAFE ON BOOT (additive, nullable, NO DEFAULT, NO new CHECK): existing rows
-- keep NULL for both, nothing is rewritten under a constraint that could fail,
-- and the operator's existing INSERT (which omits these columns) keeps working —
-- NULL is the column default. There is NO workspace_id DEFAULT 'default', so
-- lint:no-workspace-default stays clean (these are real scope keys, never
-- defaulted).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

ALTER TABLE harness_shared.test_runs
  ADD COLUMN IF NOT EXISTS harness_slug text;

ALTER TABLE harness_shared.test_runs
  ADD COLUMN IF NOT EXISTS workspace_id text;

-- Hot path: the per-hive file-history route looks up the most recent rows for
-- one file scoped to (harness_slug, workspace_id). Partial — legacy NULL rows
-- (the dogfood/admin-ui set) are never queried through this path.
CREATE INDEX IF NOT EXISTS test_runs_harness_scope_idx
  ON harness_shared.test_runs (harness_slug, workspace_id, file_path, finished_at DESC)
  WHERE harness_slug IS NOT NULL;

COMMENT ON COLUMN harness_shared.test_runs.harness_slug IS
  'enforce-system-on-generic-work P-007/P-020: which harness/hive this run belongs to. NULL = legacy dogfood/admin-ui row written before per-hive Tests-tab ingestion.';
COMMENT ON COLUMN harness_shared.test_runs.workspace_id IS
  'enforce-system-on-generic-work P-007/P-020: writing workspace for per-hive Tests-tab scoping. NULL = legacy row. Never defaulted (lint:no-workspace-default).';
