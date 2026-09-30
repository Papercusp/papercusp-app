-- 084: plan→feature provenance columns on harness_features_consolidated.
--
-- Per plan-feature-pipeline-unification-2026-05-24 Phase A P-001.
-- Promotes plan provenance from unstructured metadata_json to first-class
-- indexed columns so the bidirectional plan↔feature UI and agent context
-- injection can query efficiently.
--
--   source_plan_slug      TEXT      — slug of the plan that was promoted to
--                                     create this feature. NULL for features
--                                     not originating from a plan.
--   source_plan_item_ids  TEXT[]    — the P-NNN item ids from the plan that
--                                     this feature covers. Usually 1 item;
--                                     supports multi-item coverage.
--
-- metadata_json is NOT modified — existing values are retained. The new
-- columns are the query surface going forward; metadata_json stays for
-- other arbitrary keys.
--
-- Backfill: any row that already has metadata_json->>'source_plan' (the old
-- key written by plans:promote) is migrated to the new columns so no
-- history is lost.
--
-- Idempotent (PG 9.6+ IF NOT EXISTS).

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS source_plan_slug     TEXT;
ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS source_plan_item_ids TEXT[];

-- Index for "all features promoted from plan X" — the primary read pattern
-- for both the plan detail live-status view and the agent context query.
CREATE INDEX IF NOT EXISTS hfc_source_plan_slug_idx
  ON harness_shared.harness_features_consolidated (source_plan_slug)
  WHERE source_plan_slug IS NOT NULL;

-- Backfill from existing metadata where the old key is present. (The column
-- is `metadata` JSONB per 001-shared.sql — earlier drafts of this file said
-- `metadata_json`, which is not a column on this table and made the backfill
-- fail to parse; fixed 2026-05-31.)
UPDATE harness_shared.harness_features_consolidated
SET
  source_plan_slug     = metadata->>'source_plan',
  source_plan_item_ids = ARRAY(
    SELECT jsonb_array_elements_text(metadata->'from_plan_items')
  )
WHERE
  metadata ? 'source_plan'
  AND source_plan_slug IS NULL;
