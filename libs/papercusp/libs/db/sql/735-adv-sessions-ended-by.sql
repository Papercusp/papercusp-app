-- 735: record WHO ended an adv_session, so `ended_at`'s provenance is representable.
--
-- P-015 of plan silent-wrong-answers-2026-08-01.
--
-- WHY
-- ---
-- `ended_at` is written by two DIFFERENT kinds of writer, and both stamp `now()`:
--
--   SELF-REPORT  the session's own exit is observed and reported
--                (harness/spawn.ts, agent-mcp/bootstrap-su.ts, agent-mcp/console-launch.ts)
--                -> `ended_at` IS the end time.
--
--   OBSERVER     a sweeper NOTICES a row whose process is already gone
--                (idle-session-reaper.ts:420 and :892 via markAdvSessionEnded(id, null);
--                 adv-sessions.ts reconcileDeadTerminalLaunches)
--                -> `ended_at` is the NOTICE time. The true end time is UNKNOWN,
--                   and the gap is of arbitrary length.
--
-- Nothing in the row distinguished them, so `ended_at` was read as an observation in
-- both cases. Measured 2026-08-02 (WI-7126): one sweep stamped 9 rows within 13ms,
-- including a session whose process had been gone since 20 July. That artificial
-- cluster looked exactly like a simultaneous mass kill and survived two causal
-- hypotheses, both reported to the owner and both retracted, at a cost of ~3 hours.
--
-- WHY NOT INFER IT FROM exit_code
-- -------------------------------
-- The obvious shortcut — "exit_code IS NULL means a sweeper wrote it" — is WRONG and
-- was rejected after checking every caller: harness/spawn.ts:676 passes
-- `r.exitCode ?? null`, so a genuine self-report also writes NULL. Inferring the
-- writer from that column would over-fire on real self-reports, i.e. it would be the
-- same confident-wrong-answer this plan exists to remove.
--
-- NULL = legacy row written before this column existed. It means UNKNOWN provenance,
-- NOT 'self' — callers must treat it as un-attributed rather than assume the good case.

ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS ended_by text;

COMMENT ON COLUMN harness_shared.adv_sessions.ended_by IS
  'Who wrote ended_at: ''self'' (the session''s own exit was observed) | ''reaper'' (idle-session-reaper noticed a dead process) | ''reconciler'' (reconcileDeadTerminalLaunches noticed a dead terminal launch). NULL = legacy row, provenance UNKNOWN. When this is not ''self'', ended_at is the NOTICE time and the true end time is unknown — read coord_presence.last_active_at instead.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'adv_sessions_ended_by_check'
  ) THEN
    ALTER TABLE harness_shared.adv_sessions
      ADD CONSTRAINT adv_sessions_ended_by_check
      CHECK (ended_by IS NULL OR ended_by IN ('self', 'reaper', 'reconciler', 'cleanup'));
  END IF;
END $$;

-- Partial index: the observer-ended rows are the ones every consumer must caveat,
-- and they are the minority, so keep the index off the common path.
CREATE INDEX IF NOT EXISTS adv_sessions_observer_ended_idx
  ON harness_shared.adv_sessions (ended_at)
  WHERE ended_at IS NOT NULL AND ended_by IS DISTINCT FROM 'self';
