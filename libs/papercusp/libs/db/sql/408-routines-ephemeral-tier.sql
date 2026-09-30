-- 408-routines-ephemeral-tier.sql
-- schedule-inventory-and-ephemeral-tier-2026-06-26 P-010 / D-006.
--
-- Adds the durable|ephemeral EXECUTION-TIER discriminator to harness_shared.routines.
--   - 'durable'  : a cron routine fired by the DBOS `routinesTick` (the existing behavior).
--   - 'ephemeral': a FREQUENT, non-DBOS cadence that rides the in-process scheduled-registry
--                  (`managedSetInterval`) and fires a DETERMINISTIC action. EXCLUDED from
--                  `listDueCronRoutines`/`routinesTick` (durable-only, P-011); driven by the
--                  per-host ephemeral executor (P-012).
--
-- The ephemeral cadence (interval_sec) rides `trigger_config` jsonb, mirroring how `cron` is
-- already stored there — so no extra typed column is needed.
--
-- IDEMPOTENT + non-destructive: every existing row defaults to 'durable', so behavior is
-- byte-identical until a blueprint materializes an 'ephemeral' row (P-011) and the executor
-- (P-012) arms. Re-runnable (IF NOT EXISTS / DROP+ADD constraint).

ALTER TABLE harness_shared.routines
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'durable';

ALTER TABLE harness_shared.routines
  DROP CONSTRAINT IF EXISTS routines_tier_check;
ALTER TABLE harness_shared.routines
  ADD CONSTRAINT routines_tier_check CHECK (tier IN ('durable', 'ephemeral'));

-- Cheap scan for both readers: routinesTick's "durable + active + due" filter and the
-- ephemeral executor's "ephemeral + active" arm-set.
CREATE INDEX IF NOT EXISTS routines_tier_active_idx
  ON harness_shared.routines (tier, active) WHERE active = true;
