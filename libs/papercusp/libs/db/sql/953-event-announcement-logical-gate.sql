-- 951: stable logical identity for announced gate declarations.
--
-- An announced event key is a transport route, while logical_gate_key names
-- the product/coordination gate that route represents.  A partial index keeps
-- the active, unfired identity lookup cheap; the store serializes the lookup
-- with an advisory lock before it accepts a declaration.

ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS logical_gate_key text;

CREATE INDEX IF NOT EXISTS event_awaits_announce_logical_gate_active
  ON harness_shared.event_awaits (workspace_id, logical_gate_key)
  WHERE policy = 'announce'
    AND logical_gate_key IS NOT NULL
    AND superseded_at IS NULL
    AND cancelled_at IS NULL
    AND fired_at IS NULL;

COMMENT ON COLUMN harness_shared.event_awaits.logical_gate_key IS
  'Stable identity for one logical announced gate; active unfired declarations may not use different event keys for the same identity.';
