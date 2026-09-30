-- 1248-connected-app-device-grants.sql
-- external-app-access-to-workspaces-2026-09-29 P-005 (WI-10004014).
--
-- WHY. An app that runs where nobody can paste a key into it (a CLI on a server, a headless
-- automation host) signs in to a LOCAL workspace with the RFC 8628 device-code flow: it asks the
-- local server for a code, the user approves that code on the machine, and the app's next poll
-- receives a scoped app key (a harness_shared.connected_apps row, kind='app'). No portal account
-- and no network hop to the portal is involved (D-004).
--
-- One row per sign-in attempt. It holds the WAITING state only: the app key it produces lives in
-- connected_apps (app_id points at it once the grant is consumed), and the device code itself is
-- never stored — only its sha256, so a database dump cannot finish somebody else's sign-in.
--
-- Lifecycle: pending -> approved | denied, approved -> consumed (the poll that received the key).
-- A row is useless once expires_at has passed; the store deletes such rows when it creates a new
-- grant, so the table stays bounded without a sweeper (same as hosted_cli_device_grants).
--
-- Reuse note: the portal's psu sign-in has its own table (papercusp_auth.hosted_cli_device_grants,
-- migration 1209). That one issues portal CLI tokens for an ORGANIZATION on the hosted control
-- plane; this one issues workspace app keys on a local install that may never talk to the portal.
-- They share the protocol and the route shape (routes/hosted-cli), not the data.
--
-- Additive only: a new table, index and policy. Nothing the deployed release reads changes.
-- FORWARD-COMPAT: the partial unique index below is on a table this same migration creates, so no deployed release has any INSERT ... ON CONFLICT against it (or any other reference to it) that could lose an arbiter.

CREATE TABLE IF NOT EXISTS harness_shared.connected_app_device_grants (
  -- sha256 hex of the device code the app polls with. The plaintext code is never stored.
  device_code_hash text        PRIMARY KEY
                               CONSTRAINT connected_app_device_grants_hash_shape
                               CHECK (device_code_hash ~ '^[0-9a-f]{64}$'),
  -- The short code the user reads off the app and checks on the approval page (ABCD-EFGH).
  user_code        text        NOT NULL
                               CONSTRAINT connected_app_device_grants_user_code_shape
                               CHECK (user_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  -- Display-only name the app gave for itself. Never an identifier.
  client_label     text        NOT NULL,
  -- The scopes the app asked for ({tools, harnesses, capabilities}); the key is issued with
  -- exactly these, re-validated against the hard-deny set when it is issued.
  requested_scopes jsonb       NOT NULL DEFAULT '{}'::jsonb
                               CONSTRAINT connected_app_device_grants_scopes_is_object
                               CHECK (jsonb_typeof(requested_scopes) = 'object'),
  state            text        NOT NULL DEFAULT 'pending'
                               CONSTRAINT connected_app_device_grants_state_check
                               CHECK (state IN ('pending', 'approved', 'denied', 'consumed')),
  -- Chosen by the person who approves; NULL while pending or when denied.
  workspace_id     text,
  approved_by      text,
  -- The connected_apps row the grant turned into (set when consumed).
  app_id           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  decided_at       timestamptz,
  last_polled_at   timestamptz,
  -- An approved or consumed grant always knows its workspace; the key is issued into it.
  CONSTRAINT connected_app_device_grants_approved_has_workspace
    CHECK (state IN ('pending', 'denied') OR workspace_id IS NOT NULL),
  CONSTRAINT connected_app_device_grants_consumed_has_app
    CHECK (state <> 'consumed' OR app_id IS NOT NULL)
);

-- A user code must point at exactly one LIVE sign-in; an old used code may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS connected_app_device_grants_pending_user_code_key
  ON harness_shared.connected_app_device_grants (user_code)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS connected_app_device_grants_expires_idx
  ON harness_shared.connected_app_device_grants (expires_at);

-- Every read and write goes through the admin connection (the poll arrives before any workspace
-- is known), except the consume step, which runs inside the approved workspace's transaction
-- together with the connected_apps INSERT. The policy bounds that RLS-subject step to its own
-- workspace; pending rows (workspace_id NULL) are invisible to it.
ALTER TABLE harness_shared.connected_app_device_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connected_app_device_grants_workspace_isolation
  ON harness_shared.connected_app_device_grants;
CREATE POLICY connected_app_device_grants_workspace_isolation
  ON harness_shared.connected_app_device_grants
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.connected_app_device_grants TO harness_app;

COMMENT ON TABLE harness_shared.connected_app_device_grants IS
  'RFC 8628 device-code sign-ins for apps on a local install (external-app-access P-005). pending -> approved|denied -> consumed. The device code is stored only as sha256 (device_code_hash); the issued key lives in connected_apps (app_id). Expired rows are deleted when a new grant is created.';
