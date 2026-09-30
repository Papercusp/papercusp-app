-- Migration 1100 — explicit public hosted-account admission (BYOC D-366/P-319).
--
-- Self-signup is a Papercusp-owned transaction, not an identity-provider
-- membership shortcut.  The attempt ledger is the idempotency/rate-limit
-- anchor; hosted_service owns it and the resulting entitlement projection.
-- There are deliberately no credentials or provider tokens in either table.
-- FORWARD-COMPAT: all relations and indexes below are additive new signup
-- surfaces; no existing hosted relation or uniqueness contract is narrowed.

CREATE SCHEMA IF NOT EXISTS papercusp_auth;

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_signup_attempts (
  attempt_id       text PRIMARY KEY,
  provider         text NOT NULL,
  subject          text NOT NULL,
  email            text NOT NULL,
  fingerprint      text NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  user_id          uuid,
  organization_id  uuid,
  session_id       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hosted_signup_attempts_status_ck
    CHECK (status IN ('pending', 'completed', 'rate_limited')),
  CONSTRAINT hosted_signup_attempts_attempt_nonempty_ck CHECK (btrim(attempt_id) <> ''),
  CONSTRAINT hosted_signup_attempts_provider_nonempty_ck CHECK (btrim(provider) <> ''),
  CONSTRAINT hosted_signup_attempts_subject_nonempty_ck CHECK (btrim(subject) <> ''),
  CONSTRAINT hosted_signup_attempts_email_nonempty_ck CHECK (btrim(email) <> ''),
  CONSTRAINT hosted_signup_attempts_fingerprint_nonempty_ck CHECK (btrim(fingerprint) <> ''),
  CONSTRAINT hosted_signup_attempts_completed_refs_ck CHECK (
    (status = 'completed' AND user_id IS NOT NULL AND organization_id IS NOT NULL AND session_id IS NOT NULL)
    OR (status <> 'completed')
  )
);

CREATE INDEX IF NOT EXISTS hosted_signup_attempts_email_created_idx
  ON papercusp_auth.hosted_signup_attempts (email, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS hosted_signup_attempts_provider_subject_idx
  ON papercusp_auth.hosted_signup_attempts (provider, subject)
  WHERE status = 'completed';

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_entitlements (
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  kind            text NOT NULL,
  source          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id, kind),
  CONSTRAINT hosted_entitlements_kind_ck CHECK (btrim(kind) <> ''),
  CONSTRAINT hosted_entitlements_source_ck CHECK (btrim(source) <> '')
);

CREATE INDEX IF NOT EXISTS hosted_entitlements_user_idx
  ON papercusp_auth.hosted_entitlements (user_id, organization_id);

COMMENT ON TABLE papercusp_auth.hosted_signup_attempts IS
  'Idempotency and abuse-control ledger for explicit public hosted signup. Contains no credential material.';
COMMENT ON TABLE papercusp_auth.hosted_entitlements IS
  'Papercusp-owned entitlement granted by an approved signup admission transaction.';

ALTER TABLE papercusp_auth.hosted_signup_attempts OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_entitlements OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_signup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_signup_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_entitlements FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  papercusp_auth.hosted_signup_attempts,
  papercusp_auth.hosted_entitlements
FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
GRANT SELECT, INSERT, UPDATE ON
  papercusp_auth.hosted_signup_attempts,
  papercusp_auth.hosted_entitlements
TO hosted_service;

DROP POLICY IF EXISTS hosted_signup_attempts_service_all
  ON papercusp_auth.hosted_signup_attempts;
CREATE POLICY hosted_signup_attempts_service_all
  ON papercusp_auth.hosted_signup_attempts
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS hosted_entitlements_service_all
  ON papercusp_auth.hosted_entitlements;
CREATE POLICY hosted_entitlements_service_all
  ON papercusp_auth.hosted_entitlements
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);

-- The ordinary hosted_service lifecycle role is intentionally forbidden from
-- creating memberships (978).  Self-signup is the one reviewed admission
-- exception: a SECURITY DEFINER function owned by the non-login hosted_owner
-- role performs only the fixed owner bootstrap, while the caller remains in
-- the same surrounding transaction for rollback/idempotency.
DROP POLICY IF EXISTS organization_memberships_signup_owner
  ON papercusp_auth.organization_memberships;
CREATE POLICY organization_memberships_signup_owner
  ON papercusp_auth.organization_memberships
  FOR INSERT TO hosted_owner WITH CHECK (true);
DROP POLICY IF EXISTS organization_memberships_signup_owner_read
  ON papercusp_auth.organization_memberships;
CREATE POLICY organization_memberships_signup_owner_read
  ON papercusp_auth.organization_memberships
  FOR SELECT TO hosted_owner USING (true);

CREATE OR REPLACE FUNCTION papercusp_auth.bootstrap_hosted_self_signup_membership(
  p_organization_id uuid,
  p_user_id uuid
)
RETURNS TABLE(id uuid, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, papercusp_auth
AS $function$
BEGIN
  IF p_organization_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'self-signup membership ids are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO papercusp_auth.organization_memberships
    (organization_id, user_id, role, created_via, created_by_user_id)
  VALUES (p_organization_id, p_user_id, 'owner', 'organization_bootstrap', p_user_id)
  ON CONFLICT (organization_id, user_id) DO NOTHING;
  RETURN QUERY
    SELECT m.id, m.updated_at
      FROM papercusp_auth.organization_memberships AS m
     WHERE m.organization_id = p_organization_id
       AND m.user_id = p_user_id
       AND m.status = 'active'
     LIMIT 1;
END
$function$;
ALTER FUNCTION papercusp_auth.bootstrap_hosted_self_signup_membership(uuid, uuid)
  OWNER TO hosted_owner;
REVOKE ALL ON FUNCTION papercusp_auth.bootstrap_hosted_self_signup_membership(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION papercusp_auth.bootstrap_hosted_self_signup_membership(uuid, uuid)
  TO hosted_service;

GRANT INSERT ON papercusp_auth.legal_acceptances TO hosted_owner;
CREATE OR REPLACE FUNCTION papercusp_auth.record_hosted_self_signup_legal(
  p_organization_id uuid,
  p_user_id uuid,
  p_document_kind text,
  p_document_version text,
  p_accepted_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, papercusp_auth
AS $function$
BEGIN
  IF p_document_kind NOT IN ('terms', 'privacy') OR btrim(p_document_version) = '' THEN
    RAISE EXCEPTION 'invalid self-signup legal acceptance' USING ERRCODE = '22023';
  END IF;
  INSERT INTO papercusp_auth.legal_acceptances
    (organization_id, user_id, document_kind, document_version, acceptance_source, accepted_at)
  VALUES (
    p_organization_id, p_user_id, p_document_kind,
    p_document_version, 'hosted_ui', p_accepted_at
  )
  ON CONFLICT (organization_id, user_id, document_kind, document_version) DO NOTHING;
END
$function$;
ALTER FUNCTION papercusp_auth.record_hosted_self_signup_legal(uuid, uuid, text, text, timestamptz)
  OWNER TO hosted_owner;
REVOKE ALL ON FUNCTION papercusp_auth.record_hosted_self_signup_legal(uuid, uuid, text, text, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION papercusp_auth.record_hosted_self_signup_legal(uuid, uuid, text, text, timestamptz)
  TO hosted_service;
DROP POLICY IF EXISTS legal_acceptances_signup_owner
  ON papercusp_auth.legal_acceptances;
CREATE POLICY legal_acceptances_signup_owner
  ON papercusp_auth.legal_acceptances
  FOR INSERT TO hosted_owner WITH CHECK (true);

DO $mig1188$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'papercusp_auth'
       AND table_name IN ('hosted_signup_attempts', 'hosted_entitlements')
       AND column_name ~* '(password|hash|secret|token|credential|cookie|mfa)'
  ) THEN
    RAISE EXCEPTION '1188: hosted self-signup tables contain forbidden credential columns';
  END IF;
  IF NOT has_table_privilege('hosted_service', 'papercusp_auth.hosted_signup_attempts', 'SELECT, INSERT, UPDATE')
     OR NOT has_table_privilege('hosted_service', 'papercusp_auth.hosted_entitlements', 'SELECT, INSERT, UPDATE') THEN
    RAISE EXCEPTION '1188: hosted_service self-signup DML surface is incomplete';
  END IF;
  IF NOT has_function_privilege(
    'hosted_service',
    'papercusp_auth.bootstrap_hosted_self_signup_membership(uuid, uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION '1188: hosted_service cannot invoke self-signup membership bootstrap';
  END IF;
  IF NOT has_function_privilege(
    'hosted_service',
    'papercusp_auth.record_hosted_self_signup_legal(uuid, uuid, text, text, timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION '1188: hosted_service cannot record self-signup legal acceptance';
  END IF;
END
$mig1188$;
