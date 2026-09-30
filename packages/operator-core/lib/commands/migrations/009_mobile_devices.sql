-- Mobile device pairings + their push tokens.
--
-- Why this lives in harness_shared: pairings are workspace-scoped (PG-RLS
-- via app.workspace_id GUC, same contract as the rest of harness_shared).
-- A paired phone holds a JWT whose workspace_id claim drives the GUC at
-- request time; revocation clears the row here, which the auth middleware
-- consults on each request (TODO: cache + invalidate).
--
-- workspace_id stores the *initial* workspace at pair time. The device's
-- *currently-active* workspace lives in the JWT claim (re-issued on switch).
-- The initial value is for "list this user's pairings, ordered by where they
-- first paired" — it's not a privilege constraint.

CREATE TABLE IF NOT EXISTS harness_shared.mobile_devices (
  device_id      TEXT PRIMARY KEY,
  user_email     TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  device_kind    TEXT NOT NULL DEFAULT 'mobile' CHECK (device_kind IN ('mobile')),
  device_label   TEXT,                                   -- "the owner's iPhone 15", set by phone on first contact
  paired_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mobile_devices_workspace_idx
  ON harness_shared.mobile_devices (workspace_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS mobile_devices_user_idx
  ON harness_shared.mobile_devices (user_email);

CREATE TABLE IF NOT EXISTS harness_shared.mobile_push_tokens (
  device_id      TEXT NOT NULL REFERENCES harness_shared.mobile_devices(device_id) ON DELETE CASCADE,
  platform       TEXT NOT NULL CHECK (platform IN ('apns', 'fcm')),
  token          TEXT NOT NULL,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, platform)
);

CREATE INDEX IF NOT EXISTS mobile_push_tokens_workspace_idx
  ON harness_shared.mobile_push_tokens (device_id);

-- RLS: workspace-scoped via the existing app.workspace_id GUC contract.
-- Matches the pattern used for other harness_shared tables (see
-- spec/workspace-scoping.mdx).
ALTER TABLE harness_shared.mobile_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mobile_devices_workspace_policy ON harness_shared.mobile_devices;
CREATE POLICY mobile_devices_workspace_policy
  ON harness_shared.mobile_devices
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE harness_shared.mobile_push_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mobile_push_tokens_workspace_policy ON harness_shared.mobile_push_tokens;
CREATE POLICY mobile_push_tokens_workspace_policy
  ON harness_shared.mobile_push_tokens
  USING (
    EXISTS (
      SELECT 1 FROM harness_shared.mobile_devices d
      WHERE d.device_id = mobile_push_tokens.device_id
        AND d.workspace_id = current_setting('app.workspace_id', true)
    )
  );

-- Grant the runtime app role read/write on these tables. The 006 migration
-- shows the pattern: harness_app is the role queries run under via
-- @restart/db-org `withWorkspace`, so without these grants RLS-policy
-- evaluation never gets a chance to fire — Postgres rejects with
-- "permission denied for table" before the policy runs.
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.mobile_devices TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.mobile_push_tokens TO harness_app;
