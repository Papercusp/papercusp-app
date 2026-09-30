-- Migration 1260 — the portal half of MCP OAuth (plan external-app-access-to-workspaces-2026-09-29
-- P-325, WI-10004189; D-019, D-021).
--
-- The hosted portal is the MCP authorization server for each customer workspace (issuer
-- https://<portal>/api/workspaces/<id>). Two tables, both reachable ONLY by the hosted service
-- role, both keyed to the customer workspace like hosted_app_relay_usage (migration 1254):
--
--   1. hosted_mcp_oauth_clients  — RFC 7591 registrations, one set per customer workspace.
--   2. hosted_mcp_oauth_requests — authorization-code requests: the PKCE challenge, the redirect,
--      the requested scope, then the approver's (narrowed) grant and the one-time code's hash.
--
-- NEVER A KEY. The access token is a connected-app key minted and stored on the MACHINE (D-017,
-- D-021); the portal relays it once in the token response and keeps nothing of it. Secrets and
-- codes are stored as sha256 hex only.

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_mcp_oauth_clients (
  client_id TEXT PRIMARY KEY CONSTRAINT hosted_mcp_oauth_clients_id_shape CHECK (client_id ~ '^pcoc_[A-Za-z0-9_-]{22}$'),
  control_workspace_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  customer_workspace_id TEXT NOT NULL,
  client_name TEXT NOT NULL CHECK (length(client_name) BETWEEN 1 AND 80),
  redirect_uris TEXT[] NOT NULL CONSTRAINT hosted_mcp_oauth_clients_redirect_count
    CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  token_endpoint_auth_method TEXT NOT NULL
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  client_secret_hash TEXT CHECK (client_secret_hash IS NULL OR client_secret_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  FOREIGN KEY (control_workspace_id, organization_id, customer_workspace_id)
    REFERENCES harness_shared.customer_workspaces (workspace_id, organization_id, id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hosted_mcp_oauth_clients_workspace_idx
  ON papercusp_auth.hosted_mcp_oauth_clients (control_workspace_id, customer_workspace_id);
COMMENT ON TABLE papercusp_auth.hosted_mcp_oauth_clients IS
  'P-325 / D-021: MCP OAuth clients registered with the portal for one customer workspace. Secrets as sha256 only.';

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_mcp_oauth_requests (
  handle_hash TEXT PRIMARY KEY CHECK (handle_hash ~ '^[0-9a-f]{64}$'),
  client_id TEXT NOT NULL REFERENCES papercusp_auth.hosted_mcp_oauth_clients (client_id) ON DELETE CASCADE,
  control_workspace_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  customer_workspace_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  oauth_state TEXT,
  resource TEXT,
  requested_scopes JSONB NOT NULL DEFAULT '{}'::jsonb,
  granted_scopes JSONB,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'denied', 'redeeming', 'consumed')),
  approved_by TEXT,
  code_hash TEXT UNIQUE CHECK (code_hash IS NULL OR code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (control_workspace_id, organization_id, customer_workspace_id)
    REFERENCES harness_shared.customer_workspaces (workspace_id, organization_id, id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hosted_mcp_oauth_requests_expires_idx
  ON papercusp_auth.hosted_mcp_oauth_requests (expires_at);
COMMENT ON TABLE papercusp_auth.hosted_mcp_oauth_requests IS
  'P-325 / D-021: portal MCP OAuth authorization requests (PKCE, consent, one-time code hash). Never a key.';

-- Same ownership, RLS and grant shape as hosted_app_relay_usage (migration 1255).
ALTER TABLE papercusp_auth.hosted_mcp_oauth_clients OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_mcp_oauth_requests OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_mcp_oauth_clients FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_mcp_oauth_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_mcp_oauth_requests FORCE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA papercusp_auth TO hosted_owner, hosted_service;
REVOKE ALL ON papercusp_auth.hosted_mcp_oauth_clients
  FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
REVOKE ALL ON papercusp_auth.hosted_mcp_oauth_requests
  FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON papercusp_auth.hosted_mcp_oauth_clients TO hosted_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON papercusp_auth.hosted_mcp_oauth_requests TO hosted_service;
DROP POLICY IF EXISTS hosted_mcp_oauth_clients_service_all ON papercusp_auth.hosted_mcp_oauth_clients;
CREATE POLICY hosted_mcp_oauth_clients_service_all ON papercusp_auth.hosted_mcp_oauth_clients
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS hosted_mcp_oauth_requests_service_all ON papercusp_auth.hosted_mcp_oauth_requests;
CREATE POLICY hosted_mcp_oauth_requests_service_all ON papercusp_auth.hosted_mcp_oauth_requests
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
