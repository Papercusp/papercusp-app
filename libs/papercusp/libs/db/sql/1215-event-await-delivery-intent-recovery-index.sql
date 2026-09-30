-- P-021: the consumed event_awaits row is the existing durable wake intent.
-- The sweeper only examines fired plain one-shot wakes missing a delivery.
CREATE INDEX IF NOT EXISTS event_awaits_fired_wake_recovery
  ON harness_shared.event_awaits (workspace_id, fired_at, id)
  WHERE once = true AND policy = 'wake' AND fired_at IS NOT NULL
    AND node_id IS NULL AND root_id IS NULL;

CREATE INDEX IF NOT EXISTS event_wake_deliveries_await_lookup
  ON harness_shared.event_wake_deliveries (workspace_id, await_id);
