-- Migration 904 — hosted customer identities (BYOC plan P-075 / WI-40851,
-- decision D-076; governed by D-063, D-064, and D-067).
--
-- Papercusp's hosted control plane needs a stable, provider-neutral user id,
-- while WorkOS remains authoritative for authentication and upstream identity
-- lifecycle.  These two tables are deliberately separate from the legacy
-- papercusp_auth.users/sessions/magic_link_requests relations and from the
-- local-only harness_shared.users/user_sessions authentication surface.
--
-- FORWARD-COMPAT: this migration creates only new relations. The deployed
-- downlevel server neither reads nor writes them, and the legacy auth tables are
-- not altered, renamed, tightened, or backfilled. Rolling application code back
-- therefore leaves its complete schema contract intact.
--
-- Credential material does not belong here. In particular, neither relation may
-- gain password/hash/reset-token/MFA-secret columns. external_identities stores
-- only the opaque provider subject and non-secret profile/lifecycle metadata.
--
-- Idempotent: all objects are new and use IF NOT EXISTS. The migration runner
-- owns the transaction; do not add top-level BEGIN/COMMIT.

CREATE SCHEMA IF NOT EXISTS papercusp_auth;

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_users (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Non-authoritative profile cache for product UI. WorkOS remains the source
  -- of truth for verified email and identity lifecycle (D-063/D-067).
  primary_email         text,
  display_name          text,

  status                text        NOT NULL DEFAULT 'active',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  last_authenticated_at timestamptz,
  deactivated_at        timestamptz,
  deleted_at            timestamptz,

  CONSTRAINT hosted_users_status_ck
    CHECK (status IN ('active', 'deactivated', 'deleted')),
  CONSTRAINT hosted_users_lifecycle_ck
    CHECK (
      (status = 'active' AND deactivated_at IS NULL AND deleted_at IS NULL)
      OR (status = 'deactivated' AND deactivated_at IS NOT NULL AND deleted_at IS NULL)
      OR (status = 'deleted' AND deleted_at IS NOT NULL)
    ),
  CONSTRAINT hosted_users_updated_at_ck
    CHECK (updated_at >= created_at),
  CONSTRAINT hosted_users_last_authenticated_at_ck
    CHECK (last_authenticated_at IS NULL OR last_authenticated_at >= created_at),
  CONSTRAINT hosted_users_deactivated_at_ck
    CHECK (deactivated_at IS NULL OR deactivated_at >= created_at),
  CONSTRAINT hosted_users_deleted_at_ck
    CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

COMMENT ON TABLE papercusp_auth.hosted_users IS
  'Provider-neutral hosted customer identity. Authentication secrets stay at the upstream identity provider; application roles and grants live in Papercusp authorization tables.';

COMMENT ON COLUMN papercusp_auth.hosted_users.primary_email IS
  'Non-authoritative profile cache only. Never an authentication or authorization input.';

CREATE INDEX IF NOT EXISTS hosted_users_active_email_idx
  ON papercusp_auth.hosted_users (lower(primary_email))
  WHERE status = 'active' AND primary_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS papercusp_auth.external_identities (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  hosted_user_id      uuid        NOT NULL
    REFERENCES papercusp_auth.hosted_users(id) ON DELETE RESTRICT,

  -- provider is normalized by the CHECK. subject is intentionally opaque and
  -- case-sensitive: only the issuing provider may define its semantics.
  provider            text        NOT NULL,
  subject             text        NOT NULL,
  provider_email      text,
  profile             jsonb       NOT NULL DEFAULT '{}'::jsonb,

  status              text        NOT NULL DEFAULT 'active',
  linked_at           timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz,
  deactivated_at      timestamptz,
  deleted_at          timestamptz,

  CONSTRAINT external_identities_provider_ck
    CHECK (provider ~ '^[a-z][a-z0-9._-]{0,63}$'),
  CONSTRAINT external_identities_subject_ck
    CHECK (length(btrim(subject)) > 0),
  CONSTRAINT external_identities_profile_ck
    CHECK (jsonb_typeof(profile) = 'object'),
  CONSTRAINT external_identities_status_ck
    CHECK (status IN ('active', 'deactivated', 'deleted')),
  CONSTRAINT external_identities_lifecycle_ck
    CHECK (
      (status = 'active' AND deactivated_at IS NULL AND deleted_at IS NULL)
      OR (status = 'deactivated' AND deactivated_at IS NOT NULL AND deleted_at IS NULL)
      OR (status = 'deleted' AND deleted_at IS NOT NULL)
    ),
  CONSTRAINT external_identities_updated_at_ck
    CHECK (updated_at >= linked_at),
  CONSTRAINT external_identities_last_seen_at_ck
    CHECK (last_seen_at IS NULL OR last_seen_at >= linked_at),
  CONSTRAINT external_identities_deactivated_at_ck
    CHECK (deactivated_at IS NULL OR deactivated_at >= linked_at),
  CONSTRAINT external_identities_deleted_at_ck
    CHECK (deleted_at IS NULL OR deleted_at >= linked_at),
  CONSTRAINT external_identities_provider_subject_key
    UNIQUE (provider, subject)
);

COMMENT ON TABLE papercusp_auth.external_identities IS
  'Non-secret upstream identity links. The opaque (provider, subject) pair is globally unique and maps to one provider-neutral hosted user.';

COMMENT ON COLUMN papercusp_auth.external_identities.subject IS
  'Opaque, case-sensitive upstream subject. Never derive application authorization from this value alone.';

COMMENT ON COLUMN papercusp_auth.external_identities.profile IS
  'Non-secret provider profile metadata only. Credentials, tokens, password material, reset material, and MFA secrets are forbidden.';

CREATE INDEX IF NOT EXISTS external_identities_active_user_idx
  ON papercusp_auth.external_identities (hosted_user_id, provider)
  WHERE status = 'active';

GRANT SELECT, INSERT, UPDATE, DELETE ON papercusp_auth.hosted_users
  TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON papercusp_auth.external_identities
  TO harness_app, harness_admin;

DO $mig904$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'papercusp_auth'
       AND table_name = 'hosted_users'
  ) OR NOT EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'papercusp_auth'
       AND table_name = 'external_identities'
  ) THEN
    RAISE EXCEPTION '904: post-condition failed — hosted identity tables are missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'papercusp_auth'
       AND table_name IN ('hosted_users', 'external_identities')
       AND column_name ~* '(password|hash|reset|mfa|totp|otp|secret|credential)'
  ) THEN
    RAISE EXCEPTION '904: credential-bearing columns are forbidden on hosted identity tables';
  END IF;

  RAISE NOTICE '904: hosted user and external identity link schema installed';
END
$mig904$;
