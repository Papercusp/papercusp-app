-- 919: record an accepted self-shutdown before the managed host exits.
--
-- session:end receives the host's positive acknowledgement while the process
-- is still alive. The acknowledgement must outrank a fresh loop heartbeat in
-- work_items:release's force guard; the later child-exit report remains the
-- authoritative ended_at writer. Reactivation and re-anchor paths clear this
-- marker when the same logical session comes back.

ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS shutdown_accepted_at timestamp with time zone;

COMMENT ON COLUMN harness_shared.adv_sessions.shutdown_accepted_at IS
  'When session:end received a positive shutdown acknowledgement from this session''s managed host. This is accepted teardown intent, not proof that the child has exited; clear it on reactivation/re-anchor.';

CREATE INDEX IF NOT EXISTS adv_sessions_shutdown_accepted_owner_idx
  ON harness_shared.adv_sessions (coord_owner_id, started_at DESC)
  WHERE ended_at IS NULL AND shutdown_accepted_at IS NOT NULL;
