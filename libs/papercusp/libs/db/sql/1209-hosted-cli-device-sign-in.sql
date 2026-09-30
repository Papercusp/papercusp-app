-- Migration 1209 — psu CLI device sign-in for Papercusp-hosted workspaces (WI-10002874, byoc D-412).
-- A CLI signs in by the device-authorization pattern (RFC 8628): it asks for a device code, the
-- person approves the displayed user code in a browser that holds a hosted session, and the CLI
-- exchanges the approved device code ONCE for a revocable bearer token. Both tables are hash-only:
-- neither the device code nor the token is ever stored. A token carries identity only (user +
-- organization); every request re-derives permissions from the CURRENT membership.

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_cli_device_grants (
  device_code_hash TEXT PRIMARY KEY CHECK (device_code_hash ~ '^[0-9a-f]{64}$'),
  user_code TEXT NOT NULL UNIQUE CHECK (user_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  control_workspace_id TEXT NOT NULL,
  client_label TEXT NOT NULL CHECK (length(client_label) BETWEEN 1 AND 120),
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','consumed')),
  user_id TEXT,
  organization_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  last_polled_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK ((state IN ('approved','consumed')) = (user_id IS NOT NULL AND organization_id IS NOT NULL)),
  CHECK ((state = 'pending') = (decided_at IS NULL))
);

CREATE INDEX IF NOT EXISTS hosted_cli_device_grants_expiry_idx
  ON papercusp_auth.hosted_cli_device_grants (expires_at);

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_cli_tokens (
  id TEXT PRIMARY KEY CHECK (id ~ '^hct_[A-Za-z0-9_-]{22}$'),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  control_workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  client_label TEXT NOT NULL CHECK (length(client_label) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS hosted_cli_tokens_user_idx
  ON papercusp_auth.hosted_cli_tokens (user_id, organization_id) WHERE revoked_at IS NULL;

ALTER TABLE papercusp_auth.hosted_cli_device_grants OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_cli_tokens OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_cli_device_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_cli_device_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_cli_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_cli_tokens FORCE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA papercusp_auth TO hosted_owner, hosted_service;
REVOKE ALL ON papercusp_auth.hosted_cli_device_grants, papercusp_auth.hosted_cli_tokens
FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
GRANT SELECT,INSERT,UPDATE,DELETE ON papercusp_auth.hosted_cli_device_grants,
  papercusp_auth.hosted_cli_tokens TO hosted_service;

DROP POLICY IF EXISTS hosted_cli_device_grants_service_all ON papercusp_auth.hosted_cli_device_grants;
CREATE POLICY hosted_cli_device_grants_service_all ON papercusp_auth.hosted_cli_device_grants
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS hosted_cli_tokens_service_all ON papercusp_auth.hosted_cli_tokens;
CREATE POLICY hosted_cli_tokens_service_all ON papercusp_auth.hosted_cli_tokens
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);

COMMENT ON TABLE papercusp_auth.hosted_cli_device_grants IS
  'psu CLI device sign-in (RFC 8628 pattern). Hash-only device codes; a browser hosted session approves the user code; the approved grant is consumed exactly once for a token.';
COMMENT ON TABLE papercusp_auth.hosted_cli_tokens IS
  'Hash-only, revocable psu CLI bearer tokens. Identity only (user + organization); permissions are re-derived from current membership on every request.';
