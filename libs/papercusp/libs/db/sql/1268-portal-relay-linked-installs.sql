-- Migration 1268 — portal relay for local installs (linked customer workspaces).
--
-- external-app-access-to-workspaces-2026-09-29 P-008 (WI-10004019), design D-031; owner
-- constraints D-001 (the relay is the opt-in alternative to the user's own tunnel), D-008 and
-- D-009 (consent notice now, end-to-end mode later).
--
-- A local or bring-your-own-cloud install that opts into the Papercusp relay signs in once
-- with a device grant and then keeps an outbound connector to the portal. On the portal that
-- install is a customer workspace of kind 'linked', so the app relay (P-007), its usage counter
-- (1254), the portal MCP OAuth (P-325, 1260) and the connector table all work for it unchanged.
--
-- PORTAL
--   1. customer_workspaces.kind ('hosted' | 'linked') + linked_install_id. A linked row's
--      workspace_host_id is the synthetic 'linked-<id>' and names no workspace_hosts row, so the
--      host FK moves onto a stored generated column that is NULL for linked rows (a composite FK
--      with a NULL column is not checked). The one-live-workspace-per-organization index (D-397)
--      counts hosted rows only.
--   2. hosted_workspace_connectors drops its direct FK to workspace_hosts. Its FK to
--      customer_workspaces(workspace_id, organization_id, id, workspace_host_id) still ties a
--      hosted connector to its host through the customer row's own host FK.
--   3. hosted_cli_device_grants.purpose ('cli' | 'relay-link') + install_id: the psu device
--      grant (1209) is reused for linking, and a relay-link grant can never become a CLI token.
--
-- MACHINE
--   4. harness_shared.remote_access_portal_relay: the install's relay state, one row, shaped like
--      remote_access_own_tunnel (1262). The device code and the connector bearer are secrets and
--      are stored encrypted with pgcrypto under the operator's database key.
--
-- FORWARD-COMPAT: the deployed release never inserts a linked row and never reads the new
-- columns; the recreated one-live index and the replaced host FK accept every row the deployed
-- release writes (all of them kind 'hosted'), and the dropped connector FK only stops rejecting
-- rows the deployed release never writes.

\set ON_ERROR_STOP on

-- 1. Linked customer workspaces ---------------------------------------------------------------

ALTER TABLE harness_shared.customer_workspaces
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'hosted',
  ADD COLUMN IF NOT EXISTS linked_install_id TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_workspaces_kind_ck') THEN
    ALTER TABLE harness_shared.customer_workspaces
      ADD CONSTRAINT customer_workspaces_kind_ck CHECK (kind IN ('hosted', 'linked'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_workspaces_linked_install_ck') THEN
    ALTER TABLE harness_shared.customer_workspaces
      ADD CONSTRAINT customer_workspaces_linked_install_ck CHECK (
        (kind = 'linked') = (linked_install_id IS NOT NULL)
        AND (linked_install_id IS NULL OR linked_install_id ~ '^[a-z0-9][a-z0-9-]{7,63}$')
      );
  END IF;
END
$$;

ALTER TABLE harness_shared.customer_workspaces
  ADD COLUMN IF NOT EXISTS hosted_host_id TEXT
    GENERATED ALWAYS AS (CASE WHEN kind = 'hosted' THEN workspace_host_id END) STORED;

ALTER TABLE harness_shared.customer_workspaces DROP CONSTRAINT IF EXISTS customer_workspaces_host_fk;
ALTER TABLE harness_shared.customer_workspaces
  ADD CONSTRAINT customer_workspaces_host_fk
  FOREIGN KEY (workspace_id, hosted_host_id) REFERENCES harness_shared.workspace_hosts (workspace_id, id);

DROP INDEX IF EXISTS harness_shared.customer_workspaces_one_live_per_organization_uq;
CREATE UNIQUE INDEX customer_workspaces_one_live_per_organization_uq
  ON harness_shared.customer_workspaces (workspace_id, organization_id)
  WHERE state <> 'deleted' AND kind = 'hosted';

COMMENT ON COLUMN harness_shared.customer_workspaces.kind IS
  'external-app-access P-008 / D-031: hosted = a Papercusp machine bound to workspace_hosts; linked = the user''s own install reached through the portal relay (no workspace_hosts row).';
COMMENT ON COLUMN harness_shared.customer_workspaces.linked_install_id IS
  'kind = linked only: the install id the linked machine generated for itself. Required exactly for linked rows.';
COMMENT ON COLUMN harness_shared.customer_workspaces.hosted_host_id IS
  'workspace_host_id for hosted rows, NULL for linked rows; carries the FK to workspace_hosts.';

-- 2. Connectors no longer require a workspace_hosts row ---------------------------------------

ALTER TABLE papercusp_auth.hosted_workspace_connectors
  DROP CONSTRAINT IF EXISTS hosted_workspace_connectors_control_workspace_id_host_id_fkey;

-- 3. Device grants: psu sign-in or relay linking ----------------------------------------------

ALTER TABLE papercusp_auth.hosted_cli_device_grants
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'cli',
  ADD COLUMN IF NOT EXISTS install_id TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hosted_cli_device_grants_purpose_ck') THEN
    ALTER TABLE papercusp_auth.hosted_cli_device_grants
      ADD CONSTRAINT hosted_cli_device_grants_purpose_ck CHECK (
        purpose IN ('cli', 'relay-link')
        AND (purpose = 'relay-link') = (install_id IS NOT NULL)
        AND (install_id IS NULL OR install_id ~ '^[a-z0-9][a-z0-9-]{7,63}$')
      );
  END IF;
END
$$;

COMMENT ON COLUMN papercusp_auth.hosted_cli_device_grants.purpose IS
  'external-app-access P-008 / D-031: cli = psu sign-in (exchanged for a CLI token); relay-link = a local install linking to the portal relay (exchanged for a connector enrollment, never a CLI token).';

-- 4. The install's relay state (machine side) -------------------------------------------------

CREATE TABLE IF NOT EXISTS harness_shared.remote_access_portal_relay (
  singleton               BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  install_id              TEXT NOT NULL CHECK (install_id ~ '^[a-z0-9][a-z0-9-]{7,63}$'),
  portal_origin           TEXT NOT NULL CHECK (portal_origin ~ '^https?://[^/?#]+$'),
  state                   TEXT NOT NULL DEFAULT 'off' CHECK (state IN ('off', 'linking', 'linked')),
  consent_notice_version  INTEGER NULL CHECK (consent_notice_version IS NULL OR consent_notice_version > 0),
  consented_at            TIMESTAMPTZ NULL,
  consented_by            TEXT NULL,
  user_code               TEXT NULL,
  verification_uri        TEXT NULL,
  device_code_ct          BYTEA NULL,
  grant_expires_at        TIMESTAMPTZ NULL,
  poll_interval_sec       INTEGER NULL CHECK (poll_interval_sec IS NULL OR poll_interval_sec > 0),
  organization_id         TEXT NULL,
  customer_workspace_id   TEXT NULL,
  app_base_url            TEXT NULL,
  connector_url           TEXT NULL,
  connector_bearer_ct     BYTEA NULL,
  operator_port           INTEGER NULL CHECK (operator_port IS NULL OR operator_port BETWEEN 1 AND 65535),
  linked_at               TIMESTAMPTZ NULL,
  last_error              TEXT NULL,
  last_error_at           TIMESTAMPTZ NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT remote_access_portal_relay_consent_complete CHECK (
    (consent_notice_version IS NULL) = (consented_at IS NULL)
  ),
  CONSTRAINT remote_access_portal_relay_linking_complete CHECK (
    state <> 'linking' OR (
      consented_at IS NOT NULL AND user_code IS NOT NULL AND verification_uri IS NOT NULL
      AND device_code_ct IS NOT NULL AND grant_expires_at IS NOT NULL
    )
  ),
  CONSTRAINT remote_access_portal_relay_linked_complete CHECK (
    state <> 'linked' OR (
      consented_at IS NOT NULL AND organization_id IS NOT NULL AND customer_workspace_id IS NOT NULL
      AND app_base_url IS NOT NULL AND connector_url IS NOT NULL AND connector_bearer_ct IS NOT NULL
    )
  )
);

COMMENT ON TABLE harness_shared.remote_access_portal_relay IS
  'external-app-access P-008 / D-031: this install''s opt-in Papercusp relay (the alternative to its own tunnel, D-001). One row per install; consent to the D-009 notice is required before linking; the device code and connector bearer are encrypted with pgcrypto.';
COMMENT ON COLUMN harness_shared.remote_access_portal_relay.consent_notice_version IS
  'The version of the relay notice the user agreed to. Linking requires consent to the CURRENT version (relay-opt-in.ts RELAY_NOTICE_VERSION).';
COMMENT ON COLUMN harness_shared.remote_access_portal_relay.operator_port IS
  'The operator that turned the relay on. Only that operator runs the connector, so a second operator sharing the database never dials a second one.';
