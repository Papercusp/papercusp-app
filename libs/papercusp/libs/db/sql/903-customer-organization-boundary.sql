-- Migration 903 — hosted customer organization boundary
-- (byoc-cloud-workspaces-gcp-aws-azure-2026-08-22 P-076 / WI-40852;
-- decisions D-063, D-064, D-067, D-070, D-073).
--
-- This leaf deliberately owns only the customer boundary: organizations,
-- authoritative Papercusp memberships, and references to externally delivered
-- invitations. The sibling identity (P-075) and workspace-directory (P-077)
-- leaves are independently runnable, so user ids remain opaque UUID references
-- here and no customer-workspace foreign key is introduced in this migration.
--
-- D-067 is enforced in the data shape: application membership/role rows carry a
-- fixed `papercusp` authority and a local transaction provenance. WorkOS may
-- deliver an invitation and synchronize identity/org existence, but its webhook
-- cannot be represented as a membership-grant source. Invitation rows retain
-- only non-secret provider references; raw invite tokens never enter Postgres.
--
-- FORWARD-COMPAT: this migration is purely additive; the deployed release does
-- not query papercusp_auth and no existing relation, constraint, or index changes.
-- Idempotent: CREATE ... IF NOT EXISTS throughout. The migration runner supplies
-- the outer transaction, so this file has no top-level BEGIN/COMMIT.

CREATE SCHEMA IF NOT EXISTS papercusp_auth;

CREATE TABLE IF NOT EXISTS papercusp_auth.organizations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_provider          text NOT NULL DEFAULT 'workos',
  external_organization_id   text NOT NULL,
  display_name               text NOT NULL,
  status                     text NOT NULL DEFAULT 'active',
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  activated_at               timestamptz NOT NULL DEFAULT now(),
  suspended_at               timestamptz,
  offboarding_at             timestamptz,
  deleted_at                 timestamptz,

  CONSTRAINT organizations_identity_provider_nonempty_ck
    CHECK (btrim(identity_provider) <> ''),
  CONSTRAINT organizations_external_id_nonempty_ck
    CHECK (btrim(external_organization_id) <> ''),
  CONSTRAINT organizations_display_name_nonempty_ck
    CHECK (btrim(display_name) <> ''),
  CONSTRAINT organizations_status_ck
    CHECK (status IN ('active', 'suspended', 'offboarding', 'deleted')),
  CONSTRAINT organizations_suspended_at_ck
    CHECK (status <> 'suspended' OR suspended_at IS NOT NULL),
  CONSTRAINT organizations_offboarding_at_ck
    CHECK (status <> 'offboarding' OR offboarding_at IS NOT NULL),
  CONSTRAINT organizations_deleted_at_ck
    CHECK (status <> 'deleted' OR deleted_at IS NOT NULL),
  CONSTRAINT organizations_external_identity_uq
    UNIQUE (identity_provider, external_organization_id)
);

COMMENT ON TABLE papercusp_auth.organizations IS
  'Hosted customer/data/billing boundaries. One external identity-provider organization maps to one Papercusp organization (BYOC D-064/D-067).';
COMMENT ON COLUMN papercusp_auth.organizations.external_organization_id IS
  'Non-secret provider organization reference. Provider credentials and payload bodies are never stored here.';

CREATE TABLE IF NOT EXISTS papercusp_auth.organization_invitation_refs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL,
  identity_provider        text NOT NULL DEFAULT 'workos',
  external_invitation_id   text NOT NULL,
  invitee_email            text NOT NULL,
  intended_role            text NOT NULL DEFAULT 'member',
  status                   text NOT NULL DEFAULT 'pending',
  invited_by_user_id       uuid,
  accepted_by_user_id      uuid,
  provider_created_at      timestamptz,
  expires_at               timestamptz,
  accepted_at              timestamptz,
  revoked_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT organization_invitation_refs_org_fk
    FOREIGN KEY (organization_id)
    REFERENCES papercusp_auth.organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT organization_invitation_refs_provider_nonempty_ck
    CHECK (btrim(identity_provider) <> ''),
  CONSTRAINT organization_invitation_refs_external_id_nonempty_ck
    CHECK (btrim(external_invitation_id) <> ''),
  CONSTRAINT organization_invitation_refs_email_nonempty_ck
    CHECK (btrim(invitee_email) <> ''),
  CONSTRAINT organization_invitation_refs_role_ck
    CHECK (intended_role IN ('owner', 'admin', 'member', 'billing')),
  CONSTRAINT organization_invitation_refs_status_ck
    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  CONSTRAINT organization_invitation_refs_acceptance_pair_ck
    CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL)),
  CONSTRAINT organization_invitation_refs_accepted_at_ck
    CHECK (status <> 'accepted' OR accepted_at IS NOT NULL),
  CONSTRAINT organization_invitation_refs_expired_at_ck
    CHECK (status <> 'expired' OR expires_at IS NOT NULL),
  CONSTRAINT organization_invitation_refs_revoked_at_ck
    CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
  CONSTRAINT organization_invitation_refs_external_identity_uq
    UNIQUE (identity_provider, external_invitation_id),
  -- Enables an organization-safe composite FK from memberships. A provider
  -- invitation belonging to organization A can never create access in B.
  CONSTRAINT organization_invitation_refs_org_id_uq
    UNIQUE (organization_id, id)
);

COMMENT ON TABLE papercusp_auth.organization_invitation_refs IS
  'Non-secret references to invitations delivered by an identity provider. The row is onboarding state, not an authentication credential.';
COMMENT ON COLUMN papercusp_auth.organization_invitation_refs.external_invitation_id IS
  'Opaque provider identifier used for dedupe/replay protection; never a raw invitation token or secret.';

CREATE TABLE IF NOT EXISTS papercusp_auth.organization_memberships (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  user_id             uuid NOT NULL,
  role                text NOT NULL,
  status              text NOT NULL DEFAULT 'active',
  authority           text NOT NULL DEFAULT 'papercusp',
  created_via         text NOT NULL,
  invitation_ref_id   uuid,
  created_by_user_id  uuid,
  activated_at        timestamptz NOT NULL DEFAULT now(),
  suspended_at        timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT organization_memberships_org_fk
    FOREIGN KEY (organization_id)
    REFERENCES papercusp_auth.organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT organization_memberships_invitation_org_fk
    FOREIGN KEY (organization_id, invitation_ref_id)
    REFERENCES papercusp_auth.organization_invitation_refs (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT organization_memberships_role_ck
    CHECK (role IN ('owner', 'admin', 'member', 'billing')),
  CONSTRAINT organization_memberships_status_ck
    CHECK (status IN ('active', 'suspended', 'revoked')),
  -- D-067: lifecycle reconciliation may reduce access, but only verified
  -- Papercusp transactions may create memberships or assign application roles.
  CONSTRAINT organization_memberships_authority_ck
    CHECK (authority = 'papercusp'),
  CONSTRAINT organization_memberships_created_via_ck
    CHECK (created_via IN (
      'organization_bootstrap', 'invitation_acceptance', 'member_management'
    )),
  CONSTRAINT organization_memberships_invitation_source_ck
    CHECK (
      (created_via = 'invitation_acceptance' AND invitation_ref_id IS NOT NULL)
      OR (created_via <> 'invitation_acceptance' AND invitation_ref_id IS NULL)
    ),
  CONSTRAINT organization_memberships_suspended_at_ck
    CHECK (status <> 'suspended' OR suspended_at IS NOT NULL),
  CONSTRAINT organization_memberships_revoked_at_ck
    CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
  -- One durable lifecycle row per person/org. The same user_id remains free to
  -- appear in any number of other organizations (the multi-org contract).
  CONSTRAINT organization_memberships_org_user_uq
    UNIQUE (organization_id, user_id)
);

COMMENT ON TABLE papercusp_auth.organization_memberships IS
  'Papercusp-authoritative application memberships and roles. External lifecycle events may revoke access but never grant a row or elevate its role (BYOC D-067).';
COMMENT ON COLUMN papercusp_auth.organization_memberships.user_id IS
  'Opaque internal hosted-user UUID. The identity leaf owns its relation and later integration adds any cross-leaf binding.';

CREATE INDEX IF NOT EXISTS organizations_status_idx
  ON papercusp_auth.organizations (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS organization_invitation_refs_org_status_idx
  ON papercusp_auth.organization_invitation_refs
  (organization_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS organization_memberships_user_status_idx
  ON papercusp_auth.organization_memberships
  (user_id, status, organization_id);

CREATE INDEX IF NOT EXISTS organization_memberships_org_role_status_idx
  ON papercusp_auth.organization_memberships
  (organization_id, role, status);

DO $mig903$
DECLARE
  unexpected_secret_columns text[];
BEGIN
  IF (
    SELECT count(*)
      FROM information_schema.tables
     WHERE table_schema = 'papercusp_auth'
       AND table_name IN (
         'organizations',
         'organization_invitation_refs',
         'organization_memberships'
       )
  ) <> 3 THEN
    RAISE EXCEPTION '903: post-condition failed — customer organization boundary tables are incomplete';
  END IF;

  SELECT array_agg(format('%I.%I', table_name, column_name) ORDER BY table_name, column_name)
    INTO unexpected_secret_columns
    FROM information_schema.columns
   WHERE table_schema = 'papercusp_auth'
     AND table_name IN (
       'organizations',
       'organization_invitation_refs',
       'organization_memberships'
     )
     AND column_name ~ '(password|passcode|hash|secret|token|credential|mfa)';

  IF unexpected_secret_columns IS NOT NULL THEN
    RAISE EXCEPTION
      '903: post-condition failed — customer boundary contains identity-secret columns: %',
      unexpected_secret_columns;
  END IF;

  RAISE NOTICE '903: hosted customer organization boundary installed';
END
$mig903$;
