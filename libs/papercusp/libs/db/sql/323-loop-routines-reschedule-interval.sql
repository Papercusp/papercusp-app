-- 323-loop-routines-reschedule-interval.sql
-- loop-routines-interval-recurrence-2026-06-20 P-001 (B-LOOP-1) — make a "loop"
-- a real THIRD recurrence kind in the routines engine.
--
-- Today harness_shared.routines fires on either a cron OR an rrule (both compute
-- next_fire_at). A LOOP is the third kind: a routine that re-fires N seconds AFTER
-- its previous turn COMPLETES (the engine-managed, tracked replacement for Claude
-- /loop — a warm `coord` wake to a pinned su session). It has neither cron nor
-- rrule; its cadence is the interval-after-completion.
--
-- D-003 (owner): a DEDICATED column, NOT a trigger_config jsonb key — the
-- completion-rebase (P-002) and any future loop-dispatch query filter/index on it,
-- and the app is pre-production so deferring has no migration cost. cron/rrule stay
-- in trigger_config; the loop interval is its own column.
--
-- Two additive nullable columns (no rename, no data move) so this composes cleanly
-- with the papercup→papercusp routines rename (su-7fa79, cutover complete):
--   * reschedule_interval_sec — NULL = schedule-only (today's behavior, unchanged);
--     N = re-fire N sec after the turn settles. > 0 invariant (the 60s /loop floor
--     is policy enforced a layer up; the DB only forbids a non-positive interval).
--   * target_owner_id — the coord ownerId of the WARM session this loop wakes (the
--     `coord:send {wake}` recipient, P-004). The ownerId is the stable coord
--     identity (it survives a `claude --resume`, unlike the native session uuid),
--     so the loop keeps waking the SAME logical agent across iterations; the
--     wake-executor liveness ladder resolves owner→session for the inject/resume.
ALTER TABLE harness_shared.routines
  ADD COLUMN IF NOT EXISTS reschedule_interval_sec integer,
  ADD COLUMN IF NOT EXISTS target_owner_id text;

-- A loop interval, when present, must be positive. ADD CONSTRAINT has no
-- IF NOT EXISTS, so guard idempotency with a catalog check (re-run = no-op).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'routines_reschedule_interval_positive'
       AND conrelid = 'harness_shared.routines'::regclass
  ) THEN
    ALTER TABLE harness_shared.routines
      ADD CONSTRAINT routines_reschedule_interval_positive
      CHECK (reschedule_interval_sec IS NULL OR reschedule_interval_sec > 0);
  END IF;
END $$;

-- The completion-rebase sweep (P-002) and any loop-dispatch query scan ONLY loop
-- routines (reschedule_interval_sec IS NOT NULL) — a small set — so a partial index
-- keeps that lookup cheap regardless of how many cron/rrule routines exist (D-003).
CREATE INDEX IF NOT EXISTS routines_loop_interval_idx
  ON harness_shared.routines (reschedule_interval_sec)
  WHERE reschedule_interval_sec IS NOT NULL;
