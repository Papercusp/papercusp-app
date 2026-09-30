-- Migration 1254 — per-workspace monthly app-relay usage (plan
-- external-app-access-to-workspaces-2026-09-29 P-007, WI-10004018; D-006).
--
-- The hosted portal relays outside apps' calls to a workspace machine over its
-- outbound connector. Relay use is free with limits (D-006): a per-workspace
-- request rate (held in memory; a one-minute window needs no durability) and a
-- MONTHLY bandwidth cap, which must survive a control-plane restart, so it lives
-- here.
--
-- COUNTS ONLY. This table never holds a request's body, headers, path or key:
-- the portal must not store any part of an app call (D-008, R-38), so the only
-- columns are the workspace, the UTC month, and two counters.

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_app_relay_usage (
  control_workspace_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  customer_workspace_id TEXT NOT NULL,
  -- First day of the UTC calendar month the usage belongs to.
  month DATE NOT NULL CHECK (month = date_trunc('month', month)::date),
  bytes BIGINT NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  requests BIGINT NOT NULL DEFAULT 0 CHECK (requests >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (control_workspace_id, organization_id, customer_workspace_id, month),
  FOREIGN KEY (control_workspace_id, organization_id, customer_workspace_id)
    REFERENCES harness_shared.customer_workspaces (workspace_id, organization_id, id)
    ON DELETE CASCADE
);

COMMENT ON TABLE papercusp_auth.hosted_app_relay_usage IS
  'P-007 / D-006: monthly app-relay bandwidth and request counts per customer workspace. Counts only — never any part of a relayed call (D-008).';
