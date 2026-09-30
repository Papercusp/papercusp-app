-- Migration 300 — Scheduled plans run-scoping: the Runs-tab per-run rollup index.
--
-- Plan: scheduled-recurring-plans-2026-06-16 (P-005, D-016).
--
-- D-016 routes a scheduled run's identity through Option C's per-instance plan
-- slug (already distinct per run via the convert `implements` edge) and carries
-- the run on the work item's `payload.plan_run = { runId, runSeq, instancePlanSlug,
-- templateSlug }` (source_plan_slug holds the TEMPLATE for the Queen frontier
-- filter). The only schema this needs is a read index for the Runs-tab rollup
-- ("all work items of run R" = payload->'plan_run'->>'runId" = R), on the
-- feature-family base table behind the work_items view.
--
-- Additive + safe: a partial expression btree index on harness_features_consolidated.
-- No view/trigger change (that's the whole point of D-016). Idempotent.

\set ON_ERROR_STOP on
BEGIN;

CREATE INDEX IF NOT EXISTS hfc_source_plan_run_idx
  ON harness_shared.harness_features_consolidated ((payload -> 'plan_run' ->> 'runId'))
  WHERE (payload -> 'plan_run' ->> 'runId') IS NOT NULL;

COMMENT ON INDEX harness_shared.hfc_source_plan_run_idx IS
  'Runs-tab per-run rollup (scheduled-recurring-plans-2026-06-16 P-005/D-016): index work items by their payload.plan_run.runId so "all work items of run R" is a single indexed read. source_plan_slug carries the template for the Queen frontier filter; the run lives in payload.';

COMMIT;
