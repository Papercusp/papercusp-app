-- 906-customer-workspace-directory.sql — WI-40853 / P-077.
--
-- Hosted customer workspace directory and explicit workspace grants. This is
-- deliberately a standalone schema leaf: organization/user tables arrive in
-- sibling migrations, while the already-shipped workspace_hosts identity is
-- the one dependency that can be enforced here without serializing those leaves.
--
-- Additive, expand-only, idempotent, and safe while the previous release runs.

CREATE TABLE IF NOT EXISTS harness_shared.customer_workspaces (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  workspace_host_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'provisioning',
  created_by_principal_kind TEXT NOT NULL,
  created_by_principal_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT customer_workspaces_host_identity_uq
    UNIQUE (workspace_id, workspace_host_id),
  CONSTRAINT customer_workspaces_org_identity_uq
    UNIQUE (workspace_id, organization_id, id),
  CONSTRAINT customer_workspaces_host_fk
    FOREIGN KEY (workspace_id, workspace_host_id)
    REFERENCES harness_shared.workspace_hosts (workspace_id, id),
  CONSTRAINT customer_workspaces_organization_id_ck
    CHECK (btrim(organization_id) <> ''),
  CONSTRAINT customer_workspaces_display_name_ck
    CHECK (btrim(display_name) <> ''),
  CONSTRAINT customer_workspaces_creator_ck
    CHECK (
      btrim(created_by_principal_kind) <> ''
      AND btrim(created_by_principal_id) <> ''
    ),
  CONSTRAINT customer_workspaces_state_ck
    CHECK (state IN ('provisioning', 'active', 'suspended', 'offboarding', 'deleted')),
  CONSTRAINT customer_workspaces_deleted_at_ck
    CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS harness_shared.workspace_grants (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  customer_workspace_id TEXT NOT NULL,
  grantee_kind TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  granted_by_principal_kind TEXT NOT NULL,
  granted_by_principal_id TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_principal_kind TEXT,
  revoked_by_principal_id TEXT,
  revocation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT workspace_grants_workspace_fk
    FOREIGN KEY (workspace_id, organization_id, customer_workspace_id)
    REFERENCES harness_shared.customer_workspaces (workspace_id, organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT workspace_grants_organization_id_ck
    CHECK (btrim(organization_id) <> ''),
  CONSTRAINT workspace_grants_grantee_ck
    CHECK (btrim(grantee_kind) <> '' AND btrim(grantee_id) <> ''),
  CONSTRAINT workspace_grants_grantor_ck
    CHECK (
      btrim(granted_by_principal_kind) <> ''
      AND btrim(granted_by_principal_id) <> ''
    ),
  CONSTRAINT workspace_grants_permission_ck
    CHECK (btrim(permission) <> '' AND position('*' IN permission) = 0),
  CONSTRAINT workspace_grants_state_ck
    CHECK (state IN ('active', 'revoked', 'expired')),
  CONSTRAINT workspace_grants_expiry_ck
    CHECK (
      (expires_at IS NULL OR expires_at > granted_at)
      AND (expired_at IS NULL OR (expires_at IS NOT NULL AND expired_at >= granted_at))
    ),
  CONSTRAINT workspace_grants_lifecycle_ck
    CHECK (
      (
        state = 'active'
        AND expired_at IS NULL
        AND revoked_at IS NULL
        AND revoked_by_principal_kind IS NULL
        AND revoked_by_principal_id IS NULL
        AND revocation_reason IS NULL
      )
      OR (
        state = 'revoked'
        AND expired_at IS NULL
        AND revoked_at IS NOT NULL
        AND revoked_by_principal_kind IS NOT NULL
        AND revoked_by_principal_id IS NOT NULL
        AND btrim(revoked_by_principal_kind) <> ''
        AND btrim(revoked_by_principal_id) <> ''
      )
      OR (
        state = 'expired'
        AND expired_at IS NOT NULL
        AND revoked_at IS NULL
        AND revoked_by_principal_kind IS NULL
        AND revoked_by_principal_id IS NULL
        AND revocation_reason IS NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS customer_workspaces_organization_idx
  ON harness_shared.customer_workspaces (workspace_id, organization_id, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS workspace_grants_workspace_state_idx
  ON harness_shared.workspace_grants
  (workspace_id, organization_id, customer_workspace_id, state, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS workspace_grants_grantee_state_idx
  ON harness_shared.workspace_grants
  (workspace_id, organization_id, grantee_kind, grantee_id, state, updated_at DESC, id);

-- FORWARD-COMPAT: workspace_grants is introduced above, so the currently deployed release cannot have written duplicate active rows before this partial unique index is created.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_grants_active_uq
  ON harness_shared.workspace_grants
  (workspace_id, organization_id, customer_workspace_id, grantee_kind, grantee_id, permission)
  WHERE state = 'active';

COMMENT ON TABLE harness_shared.customer_workspaces IS
  'Hosted customer workspace directory. Each row belongs to exactly one organization and one existing workspace-host identity.';
COMMENT ON TABLE harness_shared.workspace_grants IS
  'Papercusp-authoritative, explicit workspace permissions with retained revoke/expiry lifecycle evidence; wildcard permissions are forbidden.';
