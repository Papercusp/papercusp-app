-- 094: first-class blocked_by + feature_order on harness_features_consolidated.
--
-- Per dbos-system-completion-2026-06-01 P-046. `blocked_by` and `order` were
-- only ever stuffed into the opaque `metadata` JSON by plans:promote
-- (coordination/tools/promote.ts) and nothing read them. Promote them to
-- first-class indexed columns — the shared prerequisite for the frontier
-- dispatch model (P-042 reads blocked_by; P-043 generators edge-rewrite into it).
--
--   blocked_by     TEXT[]   — canonical feature ids that must finish before this
--                             feature is dispatchable. Resolved from author refs
--                             (ids OR titles) at import time (features.ts), which
--                             also rejects unresolvable refs + dependency cycles.
--   feature_order  INTEGER  — within-wave ordering hint (the YAML `order`; `order`
--                             is a SQL reserved word, hence `feature_order`).
--
-- Storage parity with the source_plan_slug provenance columns (084): these live
-- on the consolidated table (the single source of truth) and the import writes
-- them there directly. The per-harness `harness_features` VIEWs are `SELECT *`-
-- frozen and are NOT rebuilt here — exposing these columns through the views (so
-- readFeaturesPg surfaces them as feature fields) is bundled with P-042, the
-- reader. Until then they are read from consolidated directly, exactly as
-- source_plan_slug is.
--
-- Idempotent (PG 9.6+ IF NOT EXISTS). Pure ALTER/UPDATE — no dollar-quoted blocks.

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS blocked_by    TEXT[];
ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS feature_order INTEGER;

-- "features blocked by X" / frontier readiness scans:
CREATE INDEX IF NOT EXISTS hfc_blocked_by_gin_idx
  ON harness_shared.harness_features_consolidated USING GIN (blocked_by);

-- Backfill feature_order from the old metadata key (a plain int — safe to carry
-- forward). blocked_by is NOT backfilled: the metadata refs were never resolved
-- to canonical ids (nothing honored them), and the column's contract is resolved
-- ids — future imports populate it through the resolver. Alpha, no live consumers.
UPDATE harness_shared.harness_features_consolidated
SET feature_order = (metadata->>'order')::int
WHERE metadata ? 'order'
  AND feature_order IS NULL
  AND (metadata->>'order') ~ '^-?\d+$';
