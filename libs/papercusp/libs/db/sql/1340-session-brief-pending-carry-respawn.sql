-- 1340: durable fallback for queued carry-respawns that arrive through a fresh bootstrap.
-- Nullable JSONB keeps ordinary launches and older readers unchanged.

ALTER TABLE harness_shared.session_briefs
  ADD COLUMN IF NOT EXISTS pending_carry_respawn jsonb;

COMMENT ON COLUMN harness_shared.session_briefs.pending_carry_respawn IS
  'Short-lived one-shot continuation payload consumed by a fresh bootstrap after a queued carry-respawn.';
