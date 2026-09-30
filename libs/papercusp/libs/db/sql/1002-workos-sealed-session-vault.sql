-- Migration 1002 — WorkOS sealed-session vault
-- (byoc-cloud-workspaces-gcp-aws-azure-2026-08-22 P-037 / WI-40505)
--
-- WorkOS sealed sessions contain the provider-managed encrypted session state
-- required to authenticate and revoke an upstream session. They are deliberately
-- kept out of papercusp_auth.hosted_sessions, whose documented contract is
-- non-secret metadata only, and out of every SPA-readable projection.
--
-- The vault is global to the hosted identity service because the tenant is not
-- trusted until the sealed session has been authenticated. Access is therefore
-- service-role-only rather than tenant-RLS-scoped: hosted_app and the local
-- harness roles receive no table privilege, while hosted_service is admitted by
-- one FORCE-RLS policy. The admin pool used by the control-plane composition is a
-- BYPASSRLS member of hosted_owner and remains the migration/maintenance path.

CREATE SCHEMA IF NOT EXISTS papercusp_auth;

CREATE TABLE IF NOT EXISTS papercusp_auth.workos_sealed_sessions (
  external_session_id TEXT PRIMARY KEY,
  sealed_session TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workos_sealed_sessions_external_id_nonempty
    CHECK (btrim(external_session_id) <> ''),
  CONSTRAINT workos_sealed_sessions_payload_nonempty
    CHECK (btrim(sealed_session) <> ''),
  CONSTRAINT workos_sealed_sessions_expiry_after_create
    CHECK (expires_at > created_at),
  CONSTRAINT workos_sealed_sessions_update_after_create
    CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS workos_sealed_sessions_expiry_idx
  ON papercusp_auth.workos_sealed_sessions (expires_at, external_session_id);

COMMENT ON TABLE papercusp_auth.workos_sealed_sessions IS
  'Service-only vault for WorkOS sealed session ciphertext. Never log, project, or expose sealed_session to hosted_app or browser clients.';

COMMENT ON COLUMN papercusp_auth.workos_sealed_sessions.sealed_session IS
  'Opaque WorkOS sealed-session ciphertext; secret-bearing even though provider-encrypted.';

GRANT USAGE ON SCHEMA papercusp_auth TO hosted_owner, hosted_service;

ALTER TABLE papercusp_auth.workos_sealed_sessions OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.workos_sealed_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.workos_sealed_sessions FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE papercusp_auth.workos_sealed_sessions
  FROM PUBLIC, harness_app, harness_zero, hosted_app, hosted_service;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON papercusp_auth.workos_sealed_sessions
  TO hosted_service;

DROP POLICY IF EXISTS workos_sealed_sessions_service_all
  ON papercusp_auth.workos_sealed_sessions;
CREATE POLICY workos_sealed_sessions_service_all
  ON papercusp_auth.workos_sealed_sessions
  FOR ALL TO hosted_service
  USING (true)
  WITH CHECK (true);

DO $$
DECLARE
  owner_name TEXT;
  row_security BOOLEAN;
  force_row_security BOOLEAN;
BEGIN
  SELECT owner_role.rolname, relation.relrowsecurity, relation.relforcerowsecurity
    INTO owner_name, row_security, force_row_security
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
   WHERE namespace.nspname = 'papercusp_auth'
     AND relation.relname = 'workos_sealed_sessions';

  IF owner_name IS DISTINCT FROM 'hosted_owner'
     OR row_security IS DISTINCT FROM true
     OR force_row_security IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'migration 1002: WorkOS sealed-session vault ownership/RLS post-condition failed';
  END IF;

  IF NOT has_table_privilege(
    'hosted_service',
    'papercusp_auth.workos_sealed_sessions',
    'SELECT, INSERT, UPDATE, DELETE'
  ) THEN
    RAISE EXCEPTION
      'migration 1002: hosted_service lacks the sealed-session vault DML surface';
  END IF;

  IF has_table_privilege('hosted_app', 'papercusp_auth.workos_sealed_sessions', 'SELECT')
     OR has_table_privilege('hosted_app', 'papercusp_auth.workos_sealed_sessions', 'INSERT')
     OR has_table_privilege('hosted_app', 'papercusp_auth.workos_sealed_sessions', 'UPDATE')
     OR has_table_privilege('hosted_app', 'papercusp_auth.workos_sealed_sessions', 'DELETE') THEN
    RAISE EXCEPTION
      'migration 1002: hosted_app must not access the sealed-session vault';
  END IF;
END
$$;
