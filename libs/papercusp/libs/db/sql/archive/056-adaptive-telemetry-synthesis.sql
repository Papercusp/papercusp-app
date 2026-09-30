-- 056-adaptive-telemetry-synthesis.sql
--
-- Add synthesizer outcome columns to harness_shared.adaptive_telemetry.
-- Populated after the synthesizer step (post-worker, pre-validator)
-- finishes for a tier-dispatched feature. NULL on rows from before
-- this migration (the orchestrator updates on next run).
--
-- - `synthesized` true when synth produced a commit, false when it
--   was attempted but failed (timed out, exited nonzero, produced
--   no edits). NULL when no synth attempt was made (worker count
--   resolved to 1 with synthesizeSingle off, or no manifest).
-- - `synthesis_error` populated only when `synthesized=false`;
--   short human-readable reason. NULL otherwise.

-- Guard the ALTER: on a FRESH embedded PG the table's CREATE lives in
-- ensure-schema.ts (ensureAdaptiveTelemetryTable), which runs in PARALLEL
-- with this sql/ migration runner — so this migration can execute before the
-- table exists and a bare ALTER aborts the boot with
-- `relation "harness_shared.adaptive_telemetry" does not exist` (observed on
-- the packaged release boot). No-op when the table is absent; ensure-schema's
-- CREATE already includes both columns, so a fresh DB still gets them.
DO $$
BEGIN
  IF to_regclass('harness_shared.adaptive_telemetry') IS NOT NULL THEN
    ALTER TABLE "harness_shared"."adaptive_telemetry"
      ADD COLUMN IF NOT EXISTS "synthesized" boolean,
      ADD COLUMN IF NOT EXISTS "synthesis_error" text;
  END IF;
END $$;
