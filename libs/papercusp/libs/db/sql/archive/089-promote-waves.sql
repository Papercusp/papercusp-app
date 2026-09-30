-- 089: promote waves — feature `wave` column + plan `current_wave` cursor.
--
-- Per promote-policy-and-waves-2026-05-30 (P-003). The `## Promote` policy
-- promotes a plan's features in ordered waves; a wave advances deterministically
-- when every feature in it reaches a terminal status (passed/deprecated).
--
--   harness_features_consolidated.wave  — the promote wave this feature belongs
--     to. Consolidated-only + back-written by the features/import handler, exactly
--     like source_plan_slug (migration 084): the per-harness sync trigger
--     (001-shared.sql) does NOT list it, so a per-harness feature update never
--     clobbers it. NULL = un-waved feature (legacy / non-policy promotes).
--   harness_plan_status.current_wave    — the wave a started plan has promoted up
--     to. The cursor that makes the deterministic wave-advance fire exactly once.
--
-- Idempotent (IF NOT EXISTS). No DO/function blocks (no dollar-quote concerns).

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS wave TEXT;

-- Drain-check hot path: "non-terminal features for plan X in wave N" — the
-- autoloop evaluates this per started plan. source_plan_slug is selective (one
-- plan), so a composite (source_plan_slug, wave) narrows it tightly.
CREATE INDEX IF NOT EXISTS hfc_plan_wave_idx
  ON harness_shared.harness_features_consolidated (source_plan_slug, wave)
  WHERE source_plan_slug IS NOT NULL;

ALTER TABLE harness_shared.harness_plan_status
  ADD COLUMN IF NOT EXISTS current_wave TEXT;
