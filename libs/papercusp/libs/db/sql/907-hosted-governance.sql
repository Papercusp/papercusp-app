-- Migration 907 — hosted customer governance records (BYOC P-088 / WI-40864).
--
-- This migration is a parallel-safe, additive leaf. Organization/user/workspace
-- ids are opaque UUIDs here because their sibling identity/directory migrations
-- are independently runnable; the later integration/RLS migration binds those
-- references to tenant rows. No legacy local-auth or preference relation changes.
--
-- Legal acceptance and audit history are append-only. Support access can only
-- move once from active/pending to revoked, and every grant is bounded by an
-- expiry, a concrete purpose, least-privilege scopes, and a customer-visible
-- banner. JSON fields reject credential-bearing keys and common secret values.

CREATE SCHEMA IF NOT EXISTS papercusp_auth;

CREATE OR REPLACE FUNCTION papercusp_auth.governance_json_is_safe(payload jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $safe$
  SELECT
    jsonb_typeof(payload) IN ('object', 'array')
    AND payload::text !~* '"[^\"]*(password|passcode|secret|token|credential|authorization|cookie|mfa|private[_-]?key|refresh[_-]?token)[^\"]*"[[:space:]]*:'
    AND payload::text !~* '(Bearer[[:space:]]+[A-Za-z0-9._~+/=-]{12,}|BEGIN[[:space:]][A-Z ]*PRIVATE KEY)'
$safe$;

CREATE OR REPLACE FUNCTION papercusp_auth.reject_governance_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END
$guard$;

CREATE TABLE IF NOT EXISTS papercusp_auth.legal_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  document_kind text NOT NULL,
  document_version text NOT NULL,
  acceptance_source text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT legal_acceptances_document_kind_ck
    CHECK (document_kind IN ('terms', 'privacy')),
  CONSTRAINT legal_acceptances_document_version_ck
    CHECK (btrim(document_version) <> ''),
  CONSTRAINT legal_acceptances_source_ck
    CHECK (acceptance_source IN ('hosted_ui', 'api', 'administrative')),
  CONSTRAINT legal_acceptances_evidence_safe_ck
    CHECK (papercusp_auth.governance_json_is_safe(evidence)),
  CONSTRAINT legal_acceptances_recorded_after_accept_ck
    CHECK (recorded_at >= accepted_at),
  CONSTRAINT legal_acceptances_version_uq
    UNIQUE (organization_id, user_id, document_kind, document_version)
);

DROP TRIGGER IF EXISTS legal_acceptances_append_only_trg
  ON papercusp_auth.legal_acceptances;
CREATE TRIGGER legal_acceptances_append_only_trg
  BEFORE UPDATE OR DELETE ON papercusp_auth.legal_acceptances
  FOR EACH ROW EXECUTE FUNCTION papercusp_auth.reject_governance_history_mutation();

CREATE INDEX IF NOT EXISTS legal_acceptances_org_user_idx
  ON papercusp_auth.legal_acceptances
  (organization_id, user_id, accepted_at DESC);

COMMENT ON TABLE papercusp_auth.legal_acceptances IS
  'Immutable, version-specific hosted terms/privacy acceptance evidence. No credential or raw authentication material is permitted.';

CREATE TABLE IF NOT EXISTS papercusp_auth.organization_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id uuid,
  actor_kind text NOT NULL,
  actor_id text,
  action text NOT NULL,
  purpose text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT organization_audit_events_actor_kind_ck
    CHECK (actor_kind IN ('customer_user', 'staff_admin', 'system')),
  CONSTRAINT organization_audit_events_actor_id_ck
    CHECK ((actor_kind = 'system') OR (actor_id IS NOT NULL AND btrim(actor_id) <> '')),
  CONSTRAINT organization_audit_events_action_ck CHECK (btrim(action) <> ''),
  CONSTRAINT organization_audit_events_purpose_ck CHECK (btrim(purpose) <> ''),
  CONSTRAINT organization_audit_events_target_pair_ck
    CHECK ((target_type IS NULL) = (target_id IS NULL)),
  CONSTRAINT organization_audit_events_metadata_safe_ck
    CHECK (papercusp_auth.governance_json_is_safe(metadata)),
  CONSTRAINT organization_audit_events_recorded_after_occurred_ck
    CHECK (recorded_at >= occurred_at)
);

DROP TRIGGER IF EXISTS organization_audit_events_append_only_trg
  ON papercusp_auth.organization_audit_events;
CREATE TRIGGER organization_audit_events_append_only_trg
  BEFORE UPDATE OR DELETE ON papercusp_auth.organization_audit_events
  FOR EACH ROW EXECUTE FUNCTION papercusp_auth.reject_governance_history_mutation();

CREATE INDEX IF NOT EXISTS organization_audit_events_tenant_time_idx
  ON papercusp_auth.organization_audit_events
  (organization_id, occurred_at DESC, id);
CREATE INDEX IF NOT EXISTS organization_audit_events_workspace_time_idx
  ON papercusp_auth.organization_audit_events
  (organization_id, workspace_id, occurred_at DESC, id)
  WHERE workspace_id IS NOT NULL;

COMMENT ON TABLE papercusp_auth.organization_audit_events IS
  'Tenant-scoped, append-only hosted governance history. staff_admin is a distinct audited principal class; metadata rejects secret-bearing fields.';

CREATE TABLE IF NOT EXISTS papercusp_auth.support_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id uuid,
  staff_principal_id text NOT NULL,
  granted_by_user_id uuid NOT NULL,
  purpose text NOT NULL,
  scopes text[] NOT NULL,
  banner_message text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_user_id uuid,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT support_access_grants_staff_principal_ck
    CHECK (btrim(staff_principal_id) <> ''),
  CONSTRAINT support_access_grants_purpose_ck CHECK (btrim(purpose) <> ''),
  CONSTRAINT support_access_grants_scopes_ck
    CHECK (
      cardinality(scopes) > 0
      AND NOT ('*' = ANY(scopes))
      AND array_position(scopes, '') IS NULL
    ),
  CONSTRAINT support_access_grants_banner_ck CHECK (btrim(banner_message) <> ''),
  CONSTRAINT support_access_grants_expiry_ck CHECK (expires_at > starts_at),
  CONSTRAINT support_access_grants_revocation_triplet_ck
    CHECK (
      (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revocation_reason IS NULL)
      OR (
        revoked_at IS NOT NULL
        AND revoked_by_user_id IS NOT NULL
        AND btrim(revocation_reason) <> ''
      )
    ),
  CONSTRAINT support_access_grants_revocation_time_ck
    CHECK (revoked_at IS NULL OR revoked_at >= starts_at),
  CONSTRAINT support_access_grants_updated_at_ck CHECK (updated_at >= created_at)
);

CREATE OR REPLACE FUNCTION papercusp_auth.support_access_revoke_only()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support_access_grants is revoke-only; DELETE is forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'support_access_grants revocation is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'support_access_grants may only be updated to revoke access'
      USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by_user_id', 'revocation_reason', 'updated_at'])
     <> (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by_user_id', 'revocation_reason', 'updated_at']) THEN
    RAISE EXCEPTION 'support_access_grants immutable fields cannot change during revocation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS support_access_grants_revoke_only_trg
  ON papercusp_auth.support_access_grants;
CREATE TRIGGER support_access_grants_revoke_only_trg
  BEFORE UPDATE OR DELETE ON papercusp_auth.support_access_grants
  FOR EACH ROW EXECUTE FUNCTION papercusp_auth.support_access_revoke_only();

CREATE INDEX IF NOT EXISTS support_access_grants_active_tenant_idx
  ON papercusp_auth.support_access_grants
  (organization_id, expires_at, id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS support_access_grants_active_workspace_idx
  ON papercusp_auth.support_access_grants
  (organization_id, workspace_id, expires_at, id)
  WHERE revoked_at IS NULL AND workspace_id IS NOT NULL;

COMMENT ON TABLE papercusp_auth.support_access_grants IS
  'Customer-authorized, purpose/scopes/time-bound staff support access. Active grants must be surfaced with banner_message and can only transition once to revoked.';

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_user_preferences (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  locale text NOT NULL DEFAULT 'en-US',
  time_zone text NOT NULL DEFAULT 'UTC',
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  notification_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT hosted_user_preferences_locale_ck CHECK (btrim(locale) <> ''),
  CONSTRAINT hosted_user_preferences_time_zone_ck CHECK (btrim(time_zone) <> ''),
  CONSTRAINT hosted_user_preferences_profile_safe_ck
    CHECK (papercusp_auth.governance_json_is_safe(profile)),
  CONSTRAINT hosted_user_preferences_notifications_safe_ck
    CHECK (papercusp_auth.governance_json_is_safe(notification_preferences)),
  CONSTRAINT hosted_user_preferences_updated_at_ck CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS hosted_user_preferences_user_idx
  ON papercusp_auth.hosted_user_preferences (user_id, organization_id);

COMMENT ON TABLE papercusp_auth.hosted_user_preferences IS
  'Organization-scoped hosted profile, locale, timezone, and notification preferences. JSON fields exclude authentication and credential material.';

GRANT SELECT, INSERT ON papercusp_auth.legal_acceptances
  TO harness_app, harness_admin;
GRANT SELECT, INSERT ON papercusp_auth.organization_audit_events
  TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE ON papercusp_auth.support_access_grants
  TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE ON papercusp_auth.hosted_user_preferences
  TO harness_app, harness_admin;

DO $mig907$
DECLARE
  relation_count integer;
  trigger_count integer;
BEGIN
  SELECT count(*) INTO relation_count
    FROM information_schema.tables
   WHERE table_schema = 'papercusp_auth'
     AND table_name IN (
       'legal_acceptances',
       'organization_audit_events',
       'support_access_grants',
       'hosted_user_preferences'
     );
  IF relation_count <> 4 THEN
    RAISE EXCEPTION '907: post-condition failed — hosted governance tables are incomplete';
  END IF;

  SELECT count(*) INTO trigger_count
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'legal_acceptances_append_only_trg',
       'organization_audit_events_append_only_trg',
       'support_access_grants_revoke_only_trg'
     );
  IF trigger_count <> 3 THEN
    RAISE EXCEPTION '907: post-condition failed — governance mutation guards are incomplete';
  END IF;

  RAISE NOTICE '907: hosted customer governance records installed';
END
$mig907$;
