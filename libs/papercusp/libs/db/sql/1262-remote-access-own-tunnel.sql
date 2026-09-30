-- Migration 1262 — remote_access_own_tunnel.
--
-- external-app-access-to-workspaces-2026-09-29 P-009 (WI-10004020), D-001: a local install
-- reaches outside apps through the user's OWN tunnel by default. This row is that tunnel's
-- configuration, for the whole install (not one workspace): one external-ingress listener per
-- install serves every workspace, and an app key names its workspace itself.
--
-- mode 'cloudflare' — the setup wizard provisioned a remotely-managed Cloudflare Tunnel in the
--                     user's own Cloudflare account; the operator runs cloudflared with the
--                     tunnel's run token.
-- mode 'manual'     — the user runs another outbound tunnel (Tailscale Funnel, ngrok, …) by hand
--                     and points it at ingress_port; the operator only opens the listener.
--
-- Both tokens are secrets and are stored encrypted with pgcrypto under the same key as the
-- operator's other encrypted state (db-encryption.ts getDbEncryptionKey). The operator reads
-- and writes this table over its admin connection; it is not granted to harness_app and is
-- not in any replication publication.
--
-- operator_port records which operator provisioned the tunnel. Only that operator opens the
-- listener and runs cloudflared at boot, so a second operator sharing the database (the dev
-- box's staging host) never starts a second connector.
--
-- Idempotent + non-destructive — adds a table only.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS harness_shared.remote_access_own_tunnel (
  singleton         BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  mode              TEXT NOT NULL CHECK (mode IN ('cloudflare', 'manual')),
  enabled           BOOLEAN NOT NULL DEFAULT true,
  ingress_port      INTEGER NOT NULL CHECK (ingress_port BETWEEN 1 AND 65535),
  operator_port     INTEGER NULL CHECK (operator_port IS NULL OR operator_port BETWEEN 1 AND 65535),
  hostname          TEXT NULL,
  cf_account_id     TEXT NULL,
  cf_zone_id        TEXT NULL,
  cf_zone_name      TEXT NULL,
  cf_tunnel_id      TEXT NULL,
  cf_tunnel_name    TEXT NULL,
  cf_dns_record_id  TEXT NULL,
  api_token_ct      BYTEA NULL,
  run_token_ct      BYTEA NULL,
  last_error        TEXT NULL,
  last_error_at     TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT remote_access_own_tunnel_cloudflare_complete CHECK (
    mode <> 'cloudflare' OR (
      hostname IS NOT NULL AND cf_account_id IS NOT NULL AND cf_zone_id IS NOT NULL
      AND cf_tunnel_id IS NOT NULL AND run_token_ct IS NOT NULL
    )
  ),
  CONSTRAINT remote_access_own_tunnel_ingress_not_operator CHECK (
    operator_port IS NULL OR ingress_port <> operator_port
  )
);

COMMENT ON TABLE harness_shared.remote_access_own_tunnel IS
  'external-app-access P-009 / D-001: the install''s own tunnel (Cloudflare Tunnel in the user''s account, or a manual tunnel) pointed at the external-ingress listener. One row per install; tokens encrypted with pgcrypto.';
COMMENT ON COLUMN harness_shared.remote_access_own_tunnel.ingress_port IS
  'The loopback port of the external-ingress listener the tunnel forwards to (never the operator''s own port).';
COMMENT ON COLUMN harness_shared.remote_access_own_tunnel.operator_port IS
  'The operator port that provisioned the tunnel. Only that operator opens the listener and runs cloudflared.';

ALTER TABLE harness_shared.remote_access_own_tunnel ENABLE ROW LEVEL SECURITY;
-- No policy: harness_app sees nothing. The operator uses its admin connection.
GRANT ALL ON harness_shared.remote_access_own_tunnel TO harness_admin;
