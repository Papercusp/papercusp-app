-- Migration 1005 — hosted-service lifecycle runtime boundary (armed)
-- (byoc-cloud-workspaces-gcp-aws-azure-2026-08-22 P-037 / WI-40505)
--
-- Reuses the hosted_service role and the verified webhook receipt ledger from
-- migrations 978 and 902.  The runtime needs two missing pieces before those
-- leaves can be composed safely:
--
--   1. harness_app may ASSUME hosted_service, but never inherit it ambiently;
--   2. hosted sessions, webhook receipts, and lifecycle cursors are owned by
--      hosted_owner, FORCE-RLS protected, and reachable only while the service
--      role is explicitly active.
--
-- The receipt table remains the durable queue/dedupe record.  Lifecycle cursor,
-- mutation, and closure columns extend that existing surface rather than
-- creating a second event ledger.  One small entity-cursor table is necessary
-- for cross-event stale/out-of-order rejection; a per-receipt cursor alone
-- cannot answer which event last won for the same user/org/membership.

DO $hosted_service_membership$
DECLARE
  can_grant      boolean;
  has_membership boolean;
  inherits       boolean;
  can_set        boolean;
BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION
      'migration 1005: GRANT ... WITH INHERIT FALSE requires PostgreSQL 16+, found %',
      current_setting('server_version');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hosted_service') THEN
    RAISE EXCEPTION 'migration 1005: role hosted_service is missing -- migration 978 must run first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
    RAISE EXCEPTION 'migration 1005: role harness_app is missing';
  END IF;

  SELECT r.rolsuper
      OR EXISTS (
           SELECT 1
             FROM pg_auth_members m
             JOIN pg_roles g   ON g.oid   = m.roleid
             JOIN pg_roles mem ON mem.oid = m.member
            WHERE g.rolname = 'hosted_service'
              AND mem.rolname = current_user
              AND m.admin_option
         )
    INTO can_grant
    FROM pg_roles r
   WHERE r.rolname = current_user;

  IF can_grant THEN
    EXECUTE 'GRANT hosted_service TO harness_app WITH INHERIT FALSE';
    EXECUTE 'GRANT hosted_service TO harness_app WITH SET TRUE';
  END IF;

  SELECT TRUE, m.inherit_option, m.set_option
    INTO has_membership, inherits, can_set
    FROM pg_auth_members m
    JOIN pg_roles g   ON g.oid   = m.roleid
    JOIN pg_roles mem ON mem.oid = m.member
   WHERE g.rolname = 'hosted_service'
     AND mem.rolname = 'harness_app';

  IF NOT COALESCE(has_membership, FALSE) THEN
    RAISE WARNING
      'migration 1005: harness_app cannot assume hosted_service; hosted auth/webhook runtime stays fail-closed'
      USING HINT =
        'Grant once as a superuser: GRANT hosted_service TO harness_app WITH INHERIT FALSE;';
  ELSIF inherits THEN
    RAISE EXCEPTION
      'migration 1005: harness_app inherits hosted_service ambiently -- service privileges would leak to every app query'
      USING HINT =
        'Correct as a superuser: GRANT hosted_service TO harness_app WITH INHERIT FALSE;';
  ELSIF NOT can_set THEN
    RAISE WARNING
      'migration 1005: harness_app membership cannot SET ROLE hosted_service; hosted runtime stays fail-closed'
      USING HINT =
        'Correct as a superuser: GRANT hosted_service TO harness_app WITH SET TRUE;';
  END IF;
END
$hosted_service_membership$;

ALTER TABLE papercusp_auth.webhook_event_receipts
  ADD COLUMN IF NOT EXISTS lifecycle_entity_key TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_cursor JSONB,
  ADD COLUMN IF NOT EXISTS lifecycle_mutation JSONB,
  ADD COLUMN IF NOT EXISTS closure_targets JSONB,
  ADD COLUMN IF NOT EXISTS closure_acknowledged_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS papercusp_auth.workos_lifecycle_entity_cursors (
  provider      TEXT NOT NULL DEFAULT 'workos',
  entity_key    TEXT NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  event_version TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, entity_key),
  CONSTRAINT workos_lifecycle_cursor_provider_nonempty
    CHECK (btrim(provider) <> ''),
  CONSTRAINT workos_lifecycle_cursor_entity_nonempty
    CHECK (btrim(entity_key) <> ''),
  CONSTRAINT workos_lifecycle_cursor_version_nonempty
    CHECK (btrim(event_version) <> ''),
  CONSTRAINT workos_lifecycle_cursor_event_nonempty
    CHECK (btrim(event_id) <> ''),
  CONSTRAINT workos_lifecycle_cursor_update_after_event
    CHECK (updated_at >= occurred_at)
);

CREATE INDEX IF NOT EXISTS workos_lifecycle_entity_cursors_updated_idx
  ON papercusp_auth.workos_lifecycle_entity_cursors
    (updated_at, provider, entity_key);

COMMENT ON TABLE papercusp_auth.workos_lifecycle_entity_cursors IS
  'Service-only per-entity WorkOS cursor. Prevents a late/replayed event from overwriting a newer identity, organization, invitation, membership, or session projection.';

COMMENT ON COLUMN papercusp_auth.webhook_event_receipts.closure_targets IS
  'Still-unacknowledged, secret-free access-closure targets. Retained across duplicate delivery until the idempotent closure sink succeeds.';

GRANT USAGE ON SCHEMA papercusp_auth TO hosted_owner, hosted_service;

ALTER TABLE papercusp_auth.hosted_sessions OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.webhook_event_receipts OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.workos_lifecycle_entity_cursors OWNER TO hosted_owner;

ALTER TABLE papercusp_auth.hosted_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.webhook_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.webhook_event_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.workos_lifecycle_entity_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.workos_lifecycle_entity_cursors FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  papercusp_auth.hosted_sessions,
  papercusp_auth.webhook_event_receipts,
  papercusp_auth.workos_lifecycle_entity_cursors
FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  papercusp_auth.hosted_sessions,
  papercusp_auth.webhook_event_receipts,
  papercusp_auth.workos_lifecycle_entity_cursors
TO hosted_service;

DROP POLICY IF EXISTS hosted_sessions_service_all
  ON papercusp_auth.hosted_sessions;
CREATE POLICY hosted_sessions_service_all
  ON papercusp_auth.hosted_sessions
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS webhook_event_receipts_service_all
  ON papercusp_auth.webhook_event_receipts;
CREATE POLICY webhook_event_receipts_service_all
  ON papercusp_auth.webhook_event_receipts
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS workos_lifecycle_entity_cursors_service_all
  ON papercusp_auth.workos_lifecycle_entity_cursors;
CREATE POLICY workos_lifecycle_entity_cursors_service_all
  ON papercusp_auth.workos_lifecycle_entity_cursors
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);

DO $hosted_service_runtime_postconditions$
DECLARE
  unsafe_relations TEXT[];
  membership_inherits BOOLEAN;
  membership_can_set BOOLEAN;
BEGIN
  SELECT array_agg(format('%I.%I', namespace.nspname, relation.relname)
                   ORDER BY namespace.nspname, relation.relname)
    INTO unsafe_relations
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
   WHERE (namespace.nspname, relation.relname) IN (
     ('papercusp_auth', 'hosted_sessions'),
     ('papercusp_auth', 'webhook_event_receipts'),
     ('papercusp_auth', 'workos_lifecycle_entity_cursors')
   )
     AND (
       owner_role.rolname <> 'hosted_owner'
       OR NOT relation.relrowsecurity
       OR NOT relation.relforcerowsecurity
     );

  IF unsafe_relations IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 1005: hosted service relation ownership/RLS post-condition failed: %',
      unsafe_relations;
  END IF;

  IF NOT has_table_privilege(
    'hosted_service',
    'papercusp_auth.hosted_sessions',
    'SELECT, INSERT, UPDATE, DELETE'
  ) OR NOT has_table_privilege(
    'hosted_service',
    'papercusp_auth.webhook_event_receipts',
    'SELECT, INSERT, UPDATE, DELETE'
  ) OR NOT has_table_privilege(
    'hosted_service',
    'papercusp_auth.workos_lifecycle_entity_cursors',
    'SELECT, INSERT, UPDATE, DELETE'
  ) THEN
    RAISE EXCEPTION 'migration 1005: hosted_service DML surface is incomplete';
  END IF;

  IF has_table_privilege('hosted_app', 'papercusp_auth.hosted_sessions', 'SELECT')
     OR has_table_privilege('hosted_app', 'papercusp_auth.webhook_event_receipts', 'SELECT')
     OR has_table_privilege('hosted_app', 'papercusp_auth.workos_lifecycle_entity_cursors', 'SELECT')
     OR has_table_privilege('harness_app', 'papercusp_auth.hosted_sessions', 'SELECT')
     OR has_table_privilege('harness_app', 'papercusp_auth.webhook_event_receipts', 'SELECT')
     OR has_table_privilege('harness_app', 'papercusp_auth.workos_lifecycle_entity_cursors', 'SELECT') THEN
    RAISE EXCEPTION 'migration 1005: a non-service runtime role can read hosted lifecycle state';
  END IF;

  SELECT m.inherit_option, m.set_option
    INTO membership_inherits, membership_can_set
    FROM pg_auth_members m
    JOIN pg_roles g   ON g.oid   = m.roleid
    JOIN pg_roles mem ON mem.oid = m.member
   WHERE g.rolname = 'hosted_service'
     AND mem.rolname = 'harness_app';

  IF membership_inherits IS TRUE THEN
    RAISE EXCEPTION 'migration 1005: hosted_service membership must never inherit ambiently';
  END IF;
  IF membership_can_set IS FALSE THEN
    RAISE WARNING 'migration 1005: hosted_service membership cannot SET ROLE; runtime stays fail-closed';
  END IF;
END
$hosted_service_runtime_postconditions$;
