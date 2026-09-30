-- Migration 1009 — D-143 hosted workspace reverse connectors (WI-40509 / P-039).
-- Outbound HTTPS/443 connectors authenticate with hash-only generation credentials;
-- enrollment/session tickets are short-lived, hash-only, and atomically single-use.

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_workspace_connectors (
  control_workspace_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  customer_workspace_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  route_label TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  credential_hash TEXT CHECK (credential_hash IS NULL OR credential_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('pending','active','revoked')),
  transport TEXT NOT NULL CHECK (transport IN ('sse','websocket')),
  registered_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (control_workspace_id, organization_id, customer_workspace_id, host_id),
  UNIQUE (route_label),
  FOREIGN KEY (control_workspace_id, organization_id, customer_workspace_id)
    REFERENCES harness_shared.customer_workspaces (workspace_id, organization_id, id),
  FOREIGN KEY (control_workspace_id, host_id)
    REFERENCES harness_shared.workspace_hosts (workspace_id, id),
  CHECK ((state='active')=(credential_hash IS NOT NULL)),
  CHECK ((state='revoked')=(revoked_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_workspace_connector_tickets (
  ticket_hash TEXT PRIMARY KEY CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('enrollment','session')),
  control_workspace_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  customer_workspace_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  route_label TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation > 0),
  user_id TEXT,
  hosted_session_id TEXT,
  audience TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('sse','websocket')),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > issued_at),
  CHECK ((kind='session')=(user_id IS NOT NULL AND hosted_session_id IS NOT NULL)),
  FOREIGN KEY (control_workspace_id, organization_id, customer_workspace_id, host_id)
    REFERENCES papercusp_auth.hosted_workspace_connectors
      (control_workspace_id, organization_id, customer_workspace_id, host_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS hosted_workspace_connector_tickets_expiry_idx
  ON papercusp_auth.hosted_workspace_connector_tickets (expires_at) WHERE consumed_at IS NULL;

ALTER TABLE papercusp_auth.hosted_workspace_connectors OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_workspace_connector_tickets OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_workspace_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_workspace_connectors FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_workspace_connector_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_workspace_connector_tickets FORCE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA papercusp_auth TO hosted_owner, hosted_service;
REVOKE ALL ON papercusp_auth.hosted_workspace_connectors,
  papercusp_auth.hosted_workspace_connector_tickets
FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
GRANT SELECT,INSERT,UPDATE,DELETE ON papercusp_auth.hosted_workspace_connectors,
  papercusp_auth.hosted_workspace_connector_tickets TO hosted_service;

DROP POLICY IF EXISTS hosted_workspace_connectors_service_all ON papercusp_auth.hosted_workspace_connectors;
CREATE POLICY hosted_workspace_connectors_service_all ON papercusp_auth.hosted_workspace_connectors
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS hosted_workspace_connector_tickets_service_all ON papercusp_auth.hosted_workspace_connector_tickets;
CREATE POLICY hosted_workspace_connector_tickets_service_all ON papercusp_auth.hosted_workspace_connector_tickets
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);

COMMENT ON TABLE papercusp_auth.hosted_workspace_connectors IS
  'D-143 outbound-only HTTPS/443 reverse connector bindings. Hostname is a routing hint; the authenticated org/workspace/host/generation tuple is authority.';
COMMENT ON TABLE papercusp_auth.hosted_workspace_connector_tickets IS
  'Hash-only, short-lived, atomically consumed enrollment and hosted session-exchange tickets.';
