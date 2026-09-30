-- Migration 155 — drop the legacy feature `blocked_by` column (EI-1 / P-020 / D-027 / D-028).
--
-- Plan: harness-blueprint-orchestration-2026-06-03 (P-020) + issue EI-1.
--
-- Feature→feature blocking is now the coord_links rel='blocks' polymorphic edge —
-- the single source of truth, uniform with plan-items/issues (D-027). The dispatch
-- frontier (orchestrator-loop.ts readFrontierFeatures) reads blocker sets via
-- getFeatureBlockers(); the feature-import write-path (features.ts) writes them via
-- syncFeatureBlockEdges() (lib/dbos/feature-blockers-edges.ts). So the legacy
-- `harness_features_consolidated.blocked_by text[]` column + its GIN index
-- `hfc_blocked_by_gin_idx` are now dead — this migration drops them. Pre-alpha:
-- no compat shim, no dual-storage; edges are the only blocking surface.
--
-- The ONLY object that depended on the column is the `work_items` view (migration
-- 136 created it as `SELECT *`, which froze blocked_by into its stored column list).
-- PG won't DROP COLUMN while a view lists it, so we DROP + recreate the view (still
-- `SELECT *`, now without blocked_by). Verified live on :5432 before writing this:
--   • the 19 per-schema `harness_features` views were frozen BEFORE blocked_by
--     existed and do NOT list it (information_schema.view_column_usage);
--   • no function/trigger body textually references the column (pg_proc.prosrc);
--   • nothing depends on the work_items view itself (safe to drop + recreate);
--   • 0 features currently carry blocked_by — no data to migrate (blocking lives in
--     coord_links going forward; the import write-path dual-writes edges).
--
-- Idempotent (DROP ... IF EXISTS; DROP COLUMN IF EXISTS). Composes onto
-- 000-baseline.sql for fresh/embedded-pg boots. The squashed baseline was kept in
-- sync in the SAME change: the `blocked_by text[]` column + `hfc_blocked_by_gin_idx`
-- were removed from 000-baseline.sql so the baseline reflects head (the
-- fresh-migrate "re-apply baseline RAW is a no-op" gate would otherwise fail on a
-- CREATE INDEX over a now-dropped column). On a FRESH boot the baseline never
-- creates the column, so this migration's DROPs are clean no-ops; on the live
-- :5432 box (which still has the column) they do the real work.

\set ON_ERROR_STOP on
BEGIN;

-- The work_items view (migration 136) froze blocked_by via SELECT *. Drop it so the
-- column can be dropped, then recreate it over the post-drop column set.
DROP VIEW IF EXISTS harness_shared.work_items;

ALTER TABLE harness_shared.harness_features_consolidated
    DROP COLUMN IF EXISTS blocked_by;

DROP INDEX IF EXISTS harness_shared.hfc_blocked_by_gin_idx;

-- Recreate the canonical work-item read surface (now without blocked_by). Blocking
-- is the coord_links rel='blocks' edge; see lib/dbos/feature-blockers-edges.ts.
CREATE VIEW harness_shared.work_items AS
    SELECT * FROM harness_shared.harness_features_consolidated;

COMMENT ON VIEW harness_shared.work_items IS
    'Canonical work-item read surface (D-013) over harness_features_consolidated. Discriminator = item_kind; kind-specific data = payload. Feature blocking is the coord_links rel=''blocks'' edge (EI-1 / D-027), NOT a column.';

GRANT SELECT ON harness_shared.work_items TO harness_app;
GRANT SELECT ON harness_shared.work_items TO harness_zero;

COMMIT;
