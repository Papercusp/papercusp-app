-- 1265: per-app spend, use alerts and activity for connected apps
-- (external-app-access-to-workspaces-2026-09-29 P-011, D-028).
--
-- 1. connected_apps.first_used_at — the moment a key was first used. The use write sets it once;
--    the call that sets it raises the "new app" alert (R-28). Backfilled from last_seen so a key
--    that was already in use never alerts as new.
-- 2. connected_app_networks — the networks (IPv4 /24, IPv6 /48 of the reported client address)
--    each key has been used from. A first row for a key+network raises the "new location" alert
--    (R-42). The address is caller-reported, so this feeds alerts only, never authorization.
-- 3. An index for reading an app's recorded LLM spend: worker sessions of an app's accepted
--    blueprint operations carry the caller in launch_spec.acceptedOperation.pin.callerId
--    ('app:<id>' or 'app:<id>/<suffix>').
-- 4. An index for an app's activity feed: tool_invocations.coord_owner_id is
--    operationCallerId(principal.slug) for a bearer principal, so app rows start with 'app:'.

ALTER TABLE harness_shared.connected_apps
  ADD COLUMN IF NOT EXISTS first_used_at timestamptz;

UPDATE harness_shared.connected_apps
   SET first_used_at = last_seen
 WHERE first_used_at IS NULL AND last_seen IS NOT NULL;

COMMENT ON COLUMN harness_shared.connected_apps.first_used_at IS
  'P-011 (D-028): when the key was first used. Set once by the use write; the write that sets it raises the new-app alert. NULL = never used.';

CREATE TABLE IF NOT EXISTS harness_shared.connected_app_networks (
  app_id        text        NOT NULL,
  workspace_id  text        NOT NULL,
  -- '203.0.113.0/24', '2001:db8:1::/48', or the raw value when it is not an IP address.
  network       text        NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, network)
);

CREATE INDEX IF NOT EXISTS connected_app_networks_workspace_idx
  ON harness_shared.connected_app_networks (workspace_id, app_id);

ALTER TABLE harness_shared.connected_app_networks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connected_app_networks_workspace_isolation
  ON harness_shared.connected_app_networks;
CREATE POLICY connected_app_networks_workspace_isolation
  ON harness_shared.connected_app_networks
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.connected_app_networks TO harness_app;

COMMENT ON TABLE harness_shared.connected_app_networks IS
  'P-011 (D-028): networks each connected-app key was used from. A new row raises the new-location alert. Caller-reported address: alerts only, never authorization.';

-- adv_sessions carries a large launch_spec; the partial index covers only operation workers.
CREATE INDEX IF NOT EXISTS adv_sessions_app_operation_caller_idx
  ON harness_shared.adv_sessions (
    workspace_id,
    (split_part(launch_spec->'acceptedOperation'->'pin'->>'callerId', '/', 1))
  )
  WHERE launch_spec ? 'acceptedOperation';

COMMENT ON INDEX harness_shared.adv_sessions_app_operation_caller_idx IS
  'P-011 (D-028): recorded LLM spend per connected app. The expression must stay byte-identical to split_part(launch_spec->''acceptedOperation''->''pin''->>''callerId'', ''/'', 1) and the reader must keep the launch_spec ? ''acceptedOperation'' predicate.';

CREATE INDEX IF NOT EXISTS tool_invocations_app_principal_activity_idx
  ON harness_shared.tool_invocations (workspace_id, (split_part(coord_owner_id, '/', 1)), invoked_at DESC, id DESC)
  WHERE coord_owner_id LIKE 'app:%';

COMMENT ON INDEX harness_shared.tool_invocations_app_principal_activity_idx IS
  'P-011 (D-028): a connected app''s activity feed. The expression must stay byte-identical to split_part(coord_owner_id, ''/'', 1) and the reader must keep the coord_owner_id LIKE ''app:%'' predicate.';
