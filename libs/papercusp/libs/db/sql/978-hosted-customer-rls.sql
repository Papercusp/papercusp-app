-- Migration 978 — hosted customer FORCE RLS boundary
-- EI-21540187496878597: armed at a freshly reserved number after 907 was consumed.
-- (byoc-cloud-workspaces-gcp-aws-azure-2026-08-22 P-082 / WI-40858;
-- decisions D-064, D-067, D-068, D-076).
--
-- The hosted request path performs an exact application permission check before
-- querying and then runs as hosted_app with transaction-local user,
-- organization, and selected-customer-workspace context. These policies are the
-- fail-closed database boundary underneath that check. In particular,
-- app.workspace_id is the selected customer_workspaces.id, never the Stage-A
-- process-global harness/workspace id.
--
-- hosted_service is deliberately narrower than hosted_app: provider lifecycle
-- reconciliation may upsert identity/organization existence and reduce an
-- existing membership, but it cannot create memberships, assign roles, elevate
-- access, or read/write the customer workspace directory.
--
-- Idempotent: roles are normalized, policies/triggers are replaced, grants are
-- re-stamped, and all table/role post-conditions are re-checked on every run.

-- Role provisioning + attribute normalization.
--
-- EI-21547015064885986: both halves below are privilege-sensitive in ways that
-- made the original form unrunnable by ANY non-superuser migration user, so it
-- failed identically on every boot and blocked the migration ledger behind it:
--   * CREATE ROLE requires CREATEROLE, and PostgreSQL checks that privilege
--     BEFORE the duplicate-name check. An unprivileged user therefore fails here
--     even when the role already exists -- `EXCEPTION WHEN duplicate_object`
--     never runs, so pre-creating the roles does NOT rescue it.
--   * ALTER ROLE ... NOSUPERUSER / NOREPLICATION / NOBYPASSRLS requires
--     SUPERUSER unconditionally, even when the attribute is already correct.
--
-- So this block creates what it may, re-stamps what it may, and otherwise
-- VERIFIES the safety post-condition and fails loudly. The security intent is
-- unchanged -- an unsafe hosted_* role is still never silently tolerated; only
-- the enforcement mechanism degrades from writing to checking.
DO $hosted_roles$
DECLARE
  target_role text;
  attrs       constant text :=
    'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT '
    'NOREPLICATION NOBYPASSRLS';
  is_super    boolean;
  can_create  boolean;
  unsafe      text;
BEGIN
  SELECT rolsuper, rolsuper OR rolcreaterole
    INTO is_super, can_create
    FROM pg_roles
   WHERE rolname = current_user;

  FOREACH target_role IN ARRAY
    ARRAY['hosted_owner', 'hosted_app', 'hosted_service']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      IF NOT can_create THEN
        RAISE EXCEPTION
          'migration 978: role % does not exist and migration user % lacks CREATEROLE',
          target_role, current_user
          USING HINT =
            'Provision it once as a superuser: CREATE ROLE '
            || quote_ident(target_role) || ' ' || attrs || ';';
      END IF;
      EXECUTE format('CREATE ROLE %I %s', target_role, attrs);
    ELSIF is_super THEN
      -- Existing roles are not trusted to retain safe attributes. Re-stamp them
      -- every run so a prior manual grant cannot silently defeat FORCE RLS.
      EXECUTE format('ALTER ROLE %I %s', target_role, attrs);
    END IF;
  END LOOP;

  -- Post-condition, checked on EVERY run at EVERY privilege level: a hosted_*
  -- role that can log in, bypass RLS, replicate, or self-elevate would defeat
  -- the FORCE RLS boundary this migration exists to establish.
  SELECT string_agg(rolname, ', ' ORDER BY rolname)
    INTO unsafe
    FROM pg_roles
   WHERE rolname IN ('hosted_owner', 'hosted_app', 'hosted_service')
     AND (rolsuper OR rolbypassrls OR rolreplication OR rolcanlogin
          OR rolcreatedb OR rolcreaterole OR rolinherit);
  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 978: hosted_* role(s) carry unsafe attributes: %', unsafe
      USING HINT =
        'Re-stamp as a superuser: ALTER ROLE <role> ' || attrs || ';';
  END IF;
END
$hosted_roles$;

GRANT USAGE ON SCHEMA papercusp_auth, harness_shared
  TO hosted_owner, hosted_app, hosted_service;

-- EI-21547015064885986: hosted_owner OWNS relations in both schemas below, and
-- PostgreSQL requires the INCOMING owner to hold CREATE on a relation's schema
-- before `ALTER TABLE ... OWNER TO` will accept it. A USAGE-only grant makes
-- every ownership transfer that follows fail with "permission denied for schema
-- papercusp_auth". Superusers bypass that check entirely, which is why this
-- stayed invisible until the migration ran as the ordinary migration user.
GRANT CREATE ON SCHEMA papercusp_auth, harness_shared TO hosted_owner;

-- Make the actual owner non-superuser/non-BYPASSRLS. FORCE RLS therefore binds
-- the owner too; hosted_app and hosted_service own no protected relation.
ALTER TABLE papercusp_auth.hosted_users OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.external_identities OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.organizations OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.organization_invitation_refs OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.organization_memberships OWNER TO hosted_owner;
ALTER TABLE harness_shared.customer_workspaces OWNER TO hosted_owner;
ALTER TABLE harness_shared.workspace_grants OWNER TO hosted_owner;

ALTER TABLE papercusp_auth.hosted_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_users FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.external_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.organization_invitation_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.organization_invitation_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.organization_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.customer_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.customer_workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_grants FORCE ROW LEVEL SECURITY;

-- Migration 109 grants harness_app broad defaults, and migration 904 explicitly
-- granted it identity-table DML. Remove every inherited/default grant before
-- installing the dedicated hosted-role surface. PUBLIC and the replication role
-- must not become accidental fallback paths either.
REVOKE ALL PRIVILEGES ON TABLE
  papercusp_auth.hosted_users,
  papercusp_auth.external_identities,
  papercusp_auth.organizations,
  papercusp_auth.organization_invitation_refs,
  papercusp_auth.organization_memberships,
  harness_shared.customer_workspaces,
  harness_shared.workspace_grants
FROM PUBLIC, harness_app, harness_zero, hosted_app, hosted_service;

GRANT SELECT ON
  papercusp_auth.hosted_users,
  papercusp_auth.external_identities,
  papercusp_auth.organizations
TO hosted_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  papercusp_auth.organization_invitation_refs,
  papercusp_auth.organization_memberships,
  harness_shared.customer_workspaces,
  harness_shared.workspace_grants
TO hosted_app;

GRANT SELECT, INSERT, UPDATE ON
  papercusp_auth.hosted_users,
  papercusp_auth.external_identities,
  papercusp_auth.organizations,
  papercusp_auth.organization_invitation_refs
TO hosted_service;

GRANT SELECT, UPDATE ON papercusp_auth.organization_memberships
  TO hosted_service;

-- Re-create named policies so rerunning the migration also repairs drift.
DROP POLICY IF EXISTS hosted_users_app_select
  ON papercusp_auth.hosted_users;
CREATE POLICY hosted_users_app_select
  ON papercusp_auth.hosted_users
  FOR SELECT TO hosted_app
  USING (
    id::text = NULLIF(current_setting('app.user_id', true), '')
  );

DROP POLICY IF EXISTS hosted_users_service_select
  ON papercusp_auth.hosted_users;
CREATE POLICY hosted_users_service_select
  ON papercusp_auth.hosted_users
  FOR SELECT TO hosted_service USING (true);
DROP POLICY IF EXISTS hosted_users_service_insert
  ON papercusp_auth.hosted_users;
CREATE POLICY hosted_users_service_insert
  ON papercusp_auth.hosted_users
  FOR INSERT TO hosted_service WITH CHECK (true);
DROP POLICY IF EXISTS hosted_users_service_update
  ON papercusp_auth.hosted_users;
CREATE POLICY hosted_users_service_update
  ON papercusp_auth.hosted_users
  FOR UPDATE TO hosted_service USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS external_identities_app_select
  ON papercusp_auth.external_identities;
CREATE POLICY external_identities_app_select
  ON papercusp_auth.external_identities
  FOR SELECT TO hosted_app
  USING (
    hosted_user_id::text = NULLIF(current_setting('app.user_id', true), '')
  );

DROP POLICY IF EXISTS external_identities_service_select
  ON papercusp_auth.external_identities;
CREATE POLICY external_identities_service_select
  ON papercusp_auth.external_identities
  FOR SELECT TO hosted_service USING (true);
DROP POLICY IF EXISTS external_identities_service_insert
  ON papercusp_auth.external_identities;
CREATE POLICY external_identities_service_insert
  ON papercusp_auth.external_identities
  FOR INSERT TO hosted_service WITH CHECK (true);
DROP POLICY IF EXISTS external_identities_service_update
  ON papercusp_auth.external_identities;
CREATE POLICY external_identities_service_update
  ON papercusp_auth.external_identities
  FOR UPDATE TO hosted_service USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS organizations_app_select
  ON papercusp_auth.organizations;
CREATE POLICY organizations_app_select
  ON papercusp_auth.organizations
  FOR SELECT TO hosted_app
  USING (
    id::text = NULLIF(current_setting('app.organization_id', true), '')
  );

DROP POLICY IF EXISTS organizations_service_select
  ON papercusp_auth.organizations;
CREATE POLICY organizations_service_select
  ON papercusp_auth.organizations
  FOR SELECT TO hosted_service USING (true);
DROP POLICY IF EXISTS organizations_service_insert
  ON papercusp_auth.organizations;
CREATE POLICY organizations_service_insert
  ON papercusp_auth.organizations
  FOR INSERT TO hosted_service WITH CHECK (true);
DROP POLICY IF EXISTS organizations_service_update
  ON papercusp_auth.organizations;
CREATE POLICY organizations_service_update
  ON papercusp_auth.organizations
  FOR UPDATE TO hosted_service USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS organization_invitation_refs_app_scope
  ON papercusp_auth.organization_invitation_refs;
CREATE POLICY organization_invitation_refs_app_scope
  ON papercusp_auth.organization_invitation_refs
  FOR ALL TO hosted_app
  USING (
    organization_id::text = NULLIF(current_setting('app.organization_id', true), '')
  )
  WITH CHECK (
    organization_id::text = NULLIF(current_setting('app.organization_id', true), '')
  );

DROP POLICY IF EXISTS organization_invitation_refs_service_select
  ON papercusp_auth.organization_invitation_refs;
CREATE POLICY organization_invitation_refs_service_select
  ON papercusp_auth.organization_invitation_refs
  FOR SELECT TO hosted_service USING (true);
DROP POLICY IF EXISTS organization_invitation_refs_service_insert
  ON papercusp_auth.organization_invitation_refs;
CREATE POLICY organization_invitation_refs_service_insert
  ON papercusp_auth.organization_invitation_refs
  FOR INSERT TO hosted_service WITH CHECK (true);
DROP POLICY IF EXISTS organization_invitation_refs_service_update
  ON papercusp_auth.organization_invitation_refs;
CREATE POLICY organization_invitation_refs_service_update
  ON papercusp_auth.organization_invitation_refs
  FOR UPDATE TO hosted_service USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS organization_memberships_app_scope
  ON papercusp_auth.organization_memberships;
CREATE POLICY organization_memberships_app_scope
  ON papercusp_auth.organization_memberships
  FOR ALL TO hosted_app
  USING (
    organization_id::text = NULLIF(current_setting('app.organization_id', true), '')
  )
  WITH CHECK (
    organization_id::text = NULLIF(current_setting('app.organization_id', true), '')
  );

DROP POLICY IF EXISTS organization_memberships_service_select
  ON papercusp_auth.organization_memberships;
CREATE POLICY organization_memberships_service_select
  ON papercusp_auth.organization_memberships
  FOR SELECT TO hosted_service USING (true);
DROP POLICY IF EXISTS organization_memberships_service_reduce
  ON papercusp_auth.organization_memberships;
CREATE POLICY organization_memberships_service_reduce
  ON papercusp_auth.organization_memberships
  FOR UPDATE TO hosted_service
  USING (true)
  WITH CHECK (status IN ('active', 'suspended', 'revoked'));

DROP POLICY IF EXISTS customer_workspaces_app_scope
  ON harness_shared.customer_workspaces;
CREATE POLICY customer_workspaces_app_scope
  ON harness_shared.customer_workspaces
  FOR ALL TO hosted_app
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND id = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND id = NULLIF(current_setting('app.workspace_id', true), '')
  );

DROP POLICY IF EXISTS workspace_grants_app_scope
  ON harness_shared.workspace_grants;
CREATE POLICY workspace_grants_app_scope
  ON harness_shared.workspace_grants
  FOR ALL TO hosted_app
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND customer_workspace_id = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND customer_workspace_id = NULLIF(current_setting('app.workspace_id', true), '')
  );

-- RLS cannot compare OLD and NEW in WITH CHECK. This trigger is the second half
-- of the service-role policy: it permits idempotent or access-reducing lifecycle
-- movement only, while freezing every membership/authority identity field.
CREATE OR REPLACE FUNCTION papercusp_auth.enforce_hosted_service_membership_reduction()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  old_rank integer;
  new_rank integer;
BEGIN
  IF NOT pg_has_role(current_user, 'hosted_service', 'USAGE') THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.authority IS DISTINCT FROM OLD.authority
    OR NEW.created_via IS DISTINCT FROM OLD.created_via
    OR NEW.invitation_ref_id IS DISTINCT FROM OLD.invitation_ref_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'hosted_service may only reduce membership lifecycle state';
  END IF;

  old_rank := CASE OLD.status
    WHEN 'active' THEN 0
    WHEN 'suspended' THEN 1
    WHEN 'revoked' THEN 2
  END;
  new_rank := CASE NEW.status
    WHEN 'active' THEN 0
    WHEN 'suspended' THEN 1
    WHEN 'revoked' THEN 2
  END;

  IF new_rank < old_rank THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'hosted_service may not restore or elevate membership access';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION papercusp_auth.enforce_hosted_service_membership_reduction()
  FROM PUBLIC;
ALTER FUNCTION papercusp_auth.enforce_hosted_service_membership_reduction()
  OWNER TO hosted_owner;

DROP TRIGGER IF EXISTS organization_memberships_hosted_service_reduce_trg
  ON papercusp_auth.organization_memberships;
CREATE TRIGGER organization_memberships_hosted_service_reduce_trg
  BEFORE UPDATE ON papercusp_auth.organization_memberships
  FOR EACH ROW
  EXECUTE FUNCTION papercusp_auth.enforce_hosted_service_membership_reduction();

DO $mig907$
DECLARE
  unsafe_roles text[];
  unsafe_tables text[];
BEGIN
  SELECT array_agg(rolname ORDER BY rolname)
    INTO unsafe_roles
    FROM pg_roles
   WHERE rolname IN ('hosted_owner', 'hosted_app', 'hosted_service')
     AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolcanlogin);

  IF unsafe_roles IS NOT NULL THEN
    RAISE EXCEPTION
      '907: hosted roles retain unsafe attributes: %', unsafe_roles;
  END IF;

  IF (
    SELECT count(*)
      FROM pg_roles
     WHERE rolname IN ('hosted_owner', 'hosted_app', 'hosted_service')
  ) <> 3 THEN
    RAISE EXCEPTION '907: hosted role set is incomplete';
  END IF;

  SELECT array_agg(format('%I.%I', n.nspname, c.relname)
                   ORDER BY n.nspname, c.relname)
    INTO unsafe_tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles owner_role ON owner_role.oid = c.relowner
   WHERE (n.nspname, c.relname) IN (
     ('papercusp_auth', 'hosted_users'),
     ('papercusp_auth', 'external_identities'),
     ('papercusp_auth', 'organizations'),
     ('papercusp_auth', 'organization_invitation_refs'),
     ('papercusp_auth', 'organization_memberships'),
     ('harness_shared', 'customer_workspaces'),
     ('harness_shared', 'workspace_grants')
   )
     AND (
       NOT c.relrowsecurity
       OR NOT c.relforcerowsecurity
       OR owner_role.rolname <> 'hosted_owner'
       OR owner_role.rolsuper
       OR owner_role.rolbypassrls
     );

  IF unsafe_tables IS NOT NULL THEN
    RAISE EXCEPTION
      '907: hosted tables lack forced RLS or a safe owner: %', unsafe_tables;
  END IF;

  IF has_table_privilege('hosted_service', 'papercusp_auth.organization_memberships', 'INSERT')
    OR has_table_privilege('hosted_service', 'harness_shared.customer_workspaces', 'SELECT')
    OR has_table_privilege('hosted_service', 'harness_shared.workspace_grants', 'SELECT')
  THEN
    RAISE EXCEPTION '907: hosted_service grant surface exceeds lifecycle-only authority';
  END IF;

  RAISE NOTICE '907: hosted customer FORCE RLS boundary installed';
END
$mig907$;
