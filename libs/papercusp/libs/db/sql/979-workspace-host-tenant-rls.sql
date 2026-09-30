-- Migration 979 — organization/workspace RLS for the existing workspace-host graph.
-- EI-21540187496878597: armed at a freshly reserved number after 908 was consumed.
-- (byoc-cloud-workspaces-gcp-aws-azure-2026-08-22 P-083 / WI-40859;
-- decision D-068).
--
-- Migration 887 protected these rows only with the process-global operator
-- workspace id. Hosted requests instead carry a selected customer-workspace id
-- plus its organization. This migration replaces the PUBLIC policies with
-- role-specific boundaries: local roles keep the 887 behavior, while hosted_app
-- must resolve the row through customer_workspaces using both verified GUCs.
-- Customer VMs and their provider/content ownership are unchanged.

ALTER TABLE harness_shared.workspace_host_connections OWNER TO hosted_owner;
ALTER TABLE harness_shared.workspace_hosts OWNER TO hosted_owner;
ALTER TABLE harness_shared.workspace_host_operations OWNER TO hosted_owner;
ALTER TABLE harness_shared.workspace_host_resources OWNER TO hosted_owner;
ALTER TABLE harness_shared.workspace_host_events OWNER TO hosted_owner;
ALTER TABLE harness_shared.workspace_host_logs OWNER TO hosted_owner;

ALTER TABLE harness_shared.workspace_host_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_host_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_hosts FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_host_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_host_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_host_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_host_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_host_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_host_events FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_host_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.workspace_host_logs FORCE ROW LEVEL SECURITY;

-- P-066 will replace this body when its audited, purpose-bound support-grant
-- relation exists. Until then the seam is deliberately present but incapable of
-- granting access. Its eventual implementation must bind a transaction-local
-- grant id + staff actor to the exact organization/workspace/host and reject
-- expired or revoked grants.
CREATE OR REPLACE FUNCTION papercusp_auth.workspace_host_support_grant_allows(
  control_workspace_id text,
  workspace_host_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT false
$function$;

COMMENT ON FUNCTION papercusp_auth.workspace_host_support_grant_allows(text, text) IS
  'Fail-closed P-083 support-access seam. P-066 may replace the body only with an audited, time-bounded exact-target grant check.';

REVOKE ALL ON FUNCTION papercusp_auth.workspace_host_support_grant_allows(text, text)
  FROM PUBLIC;
ALTER FUNCTION papercusp_auth.workspace_host_support_grant_allows(text, text)
  OWNER TO hosted_owner;
GRANT EXECUTE ON FUNCTION papercusp_auth.workspace_host_support_grant_allows(text, text)
  TO hosted_app;

CREATE OR REPLACE FUNCTION harness_shared.workspace_host_scope_allows(
  control_workspace_id text,
  workspace_host_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, harness_shared, papercusp_auth
AS $function$
  SELECT
    EXISTS (
      SELECT 1
        FROM harness_shared.customer_workspaces AS customer_workspace
       WHERE customer_workspace.workspace_id = control_workspace_id
         AND customer_workspace.workspace_host_id = workspace_host_id
         AND customer_workspace.organization_id =
             NULLIF(current_setting('app.organization_id', true), '')
         AND customer_workspace.id =
             NULLIF(current_setting('app.workspace_id', true), '')
    )
    OR papercusp_auth.workspace_host_support_grant_allows(
      control_workspace_id,
      workspace_host_id
    )
$function$;

CREATE OR REPLACE FUNCTION harness_shared.workspace_host_connection_scope_allows(
  control_workspace_id text,
  connection_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, harness_shared, papercusp_auth
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM harness_shared.workspace_hosts AS workspace_host
     WHERE workspace_host.workspace_id = control_workspace_id
       AND workspace_host.connection_id = connection_id
       AND harness_shared.workspace_host_scope_allows(
         workspace_host.workspace_id,
         workspace_host.id
       )
  )
$function$;

REVOKE ALL ON FUNCTION harness_shared.workspace_host_scope_allows(text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION harness_shared.workspace_host_connection_scope_allows(text, text)
  FROM PUBLIC;
ALTER FUNCTION harness_shared.workspace_host_scope_allows(text, text)
  OWNER TO hosted_owner;
ALTER FUNCTION harness_shared.workspace_host_connection_scope_allows(text, text)
  OWNER TO hosted_owner;
GRANT EXECUTE ON FUNCTION harness_shared.workspace_host_scope_allows(text, text)
  TO hosted_app;
GRANT EXECUTE ON FUNCTION harness_shared.workspace_host_connection_scope_allows(text, text)
  TO hosted_app;

REVOKE ALL PRIVILEGES ON TABLE
  harness_shared.workspace_host_connections,
  harness_shared.workspace_hosts,
  harness_shared.workspace_host_operations,
  harness_shared.workspace_host_resources,
  harness_shared.workspace_host_events,
  harness_shared.workspace_host_logs
FROM PUBLIC, hosted_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  harness_shared.workspace_host_connections,
  harness_shared.workspace_hosts,
  harness_shared.workspace_host_operations,
  harness_shared.workspace_host_resources,
  harness_shared.workspace_host_events,
  harness_shared.workspace_host_logs
TO hosted_app;

DO $workspace_host_policies$
DECLARE
  table_name text;
  hosted_predicate text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_host_connections',
    'workspace_hosts',
    'workspace_host_operations',
    'workspace_host_resources',
    'workspace_host_events',
    'workspace_host_logs'
  ] LOOP
    hosted_predicate := CASE table_name
      WHEN 'workspace_host_connections' THEN
        'harness_shared.workspace_host_connection_scope_allows(workspace_id, id)'
      WHEN 'workspace_hosts' THEN
        'harness_shared.workspace_host_scope_allows(workspace_id, id)'
      ELSE
        'harness_shared.workspace_host_scope_allows(workspace_id, host_id)'
    END;

    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON harness_shared.%I',
      table_name || '_workspace_isolation', table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON harness_shared.%I',
      table_name || '_local_workspace_isolation', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON harness_shared.%I FOR ALL TO harness_app USING (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')) WITH CHECK (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), ''''))',
      table_name || '_local_workspace_isolation', table_name
    );

    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON harness_shared.%I',
      table_name || '_local_read_isolation', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON harness_shared.%I FOR SELECT TO harness_zero USING (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), ''''))',
      table_name || '_local_read_isolation', table_name
    );

    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON harness_shared.%I',
      table_name || '_hosted_tenant_isolation', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON harness_shared.%I FOR ALL TO hosted_app USING (%s) WITH CHECK (%s)',
      table_name || '_hosted_tenant_isolation', table_name,
      hosted_predicate, hosted_predicate
    );
  END LOOP;
END
$workspace_host_policies$;

DO $mig908$
DECLARE
  unsafe_tables text[];
  legacy_public_policies text[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname)
    INTO unsafe_tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles owner_role ON owner_role.oid = c.relowner
   WHERE n.nspname = 'harness_shared'
     AND c.relname IN (
       'workspace_host_connections', 'workspace_hosts',
       'workspace_host_operations', 'workspace_host_resources',
       'workspace_host_events', 'workspace_host_logs'
     )
     AND (
       NOT c.relrowsecurity
       OR NOT c.relforcerowsecurity
       OR owner_role.rolname <> 'hosted_owner'
       OR owner_role.rolsuper
       OR owner_role.rolbypassrls
     );

  IF unsafe_tables IS NOT NULL THEN
    RAISE EXCEPTION '908: workspace-host tables lack forced RLS or a safe owner: %', unsafe_tables;
  END IF;

  SELECT array_agg(format('%I.%I', schemaname, policyname) ORDER BY tablename)
    INTO legacy_public_policies
    FROM pg_policies
   WHERE schemaname = 'harness_shared'
     AND tablename IN (
       'workspace_host_connections', 'workspace_hosts',
       'workspace_host_operations', 'workspace_host_resources',
       'workspace_host_events', 'workspace_host_logs'
     )
     AND policyname = tablename || '_workspace_isolation';

  IF legacy_public_policies IS NOT NULL THEN
    RAISE EXCEPTION '908: legacy PUBLIC workspace-only policies remain: %', legacy_public_policies;
  END IF;

  RAISE NOTICE '908: organization/workspace RLS installed for the workspace-host graph';
END
$mig908$;
