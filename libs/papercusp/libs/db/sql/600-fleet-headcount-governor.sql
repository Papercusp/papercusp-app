-- Migration 600 — persistent fleet headcount governor (WI-2479).
--
-- A target is durable on the fleet row so a routine can repair a fleet after
-- member death or operator restart without relying on an in-memory loop. The
-- launch configuration is validated and stored by fleet:headcount-target.
ALTER TABLE harness_shared.agent_fleets
  ADD COLUMN IF NOT EXISTS headcount_target integer,
  ADD COLUMN IF NOT EXISTS headcount_config jsonb,
  ADD COLUMN IF NOT EXISTS headcount_next_attempt_at bigint,
  ADD COLUMN IF NOT EXISTS headcount_backoff_ms bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS headcount_last_error text;

ALTER TABLE harness_shared.agent_fleets
  ADD CONSTRAINT agent_fleets_headcount_target_positive
  CHECK (headcount_target IS NULL OR headcount_target BETWEEN 1 AND 12);

COMMENT ON COLUMN harness_shared.agent_fleets.headcount_target IS
  'WI-2479: desired number of live desktop/headless fleet members; null disables the governor.';
COMMENT ON COLUMN harness_shared.agent_fleets.headcount_config IS
  'WI-2479: validated launch configuration used by the durable top-up routine.';
COMMENT ON COLUMN harness_shared.agent_fleets.headcount_next_attempt_at IS
  'WI-2479: epoch-ms lease/backoff barrier preventing concurrent relaunch waves.';
COMMENT ON COLUMN harness_shared.agent_fleets.headcount_backoff_ms IS
  'WI-2479: exponential top-up retry delay, capped by the governor.';
COMMENT ON COLUMN harness_shared.agent_fleets.headcount_last_error IS
  'WI-2479: bounded diagnostic from the most recent failed top-up.';
