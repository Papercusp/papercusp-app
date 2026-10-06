-- WI-10003762: event emission matches standing watches by workspace and exact key.
-- The existing active-key index also requires fired_at IS NULL, which this branch
-- intentionally does not assert because standing watches remain active after a fire.
CREATE INDEX IF NOT EXISTS event_awaits_standing_exact_key_active
  ON harness_shared.event_awaits (workspace_id, event_key)
  WHERE once = false AND cancelled_at IS NULL;
