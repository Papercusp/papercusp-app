-- 1253-identity-hook-turns-ms-spent.sql
-- portable-identity-packages-2026-09-26 P-011 (WI-10003320), plan Decision D-024.
--
-- WHY. The per-(session, turn) sink ceiling (D-009) has a wall-clock half as well as a token half.
-- It bounds the time identity hooks ADD to a turn, so it must be the sum of the time the turn's sink
-- invocations actually took. Reading it as "time since the turn began" (started_at) was only right
-- while one sink ran per turn, at turn start: a stop sink a minute into the turn would find the
-- ceiling long spent and omit everything. Each sink runs on whichever cluster worker serves its
-- request, so the sum lives beside tokens_spent and is fenced the same way, on turn_id.
--
-- Additive only: one column with a default. Nothing the deployed release reads changes.

ALTER TABLE harness_shared.identity_hook_turns
  ADD COLUMN IF NOT EXISTS ms_spent integer NOT NULL DEFAULT 0
    CONSTRAINT identity_hook_turns_ms_nonnegative CHECK (ms_spent >= 0);

COMMENT ON COLUMN harness_shared.identity_hook_turns.ms_spent IS
  'Wall-clock the turn''s identity hook sink invocations took, summed (P-011, D-024) — the turn ceiling''s time half.';
