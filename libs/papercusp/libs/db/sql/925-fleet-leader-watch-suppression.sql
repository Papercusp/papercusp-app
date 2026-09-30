-- 925-fleet-leader-operator-cancel-suppression.sql — EI-21277593085277232
--
-- Preserve an explicit operator cancellation of an auto-armed fleet-leader
-- transition watch. Ordinary reconciliation reads this marker and leaves the
-- watch suppressed; fleet:take-leadership may explicitly clear it when the
-- operator wants to re-arm the profile.

ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS cancel_reason text;

CREATE INDEX IF NOT EXISTS event_awaits_operator_cancelled_key
  ON harness_shared.event_awaits (workspace_id, subscriber_id, event_key)
  WHERE cancelled_at IS NOT NULL AND cancel_reason = 'operator';
