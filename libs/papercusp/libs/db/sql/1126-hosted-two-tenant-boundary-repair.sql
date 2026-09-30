-- 1126-hosted-two-tenant-boundary-repair.sql
-- WI-2001280 / EI-22446437182346787 / EI-22446846463226741.
--
-- The first assembled hosted two-tenant run found two boundaries that leaf
-- fixtures could not expose:
--
-- 1. Migration 979's SQL-function parameters shared names with columns in the
--    functions' inner queries. PostgreSQL resolved the unqualified right-hand
--    operands as columns, turning `workspace_host_id = workspace_host_id` and
--    `connection_id = connection_id` into self-equalities. A tenant owning one
--    host in a control plane could therefore see every host and connection in
--    that control plane. Positional parameters make the binding unambiguous.
-- 2. Connector enrollment checked a customer-workspace row in application SQL
--    while running as hosted_service, a role migration 978 deliberately denies
--    that table. Encode the exact customer-workspace/host tuple as a foreign key
--    instead, so integrity is enforced by Postgres without widening service-role
--    read authority.
--
-- Expand-only and safe for the currently deployed release: function signatures
-- stay identical, and both constraints only strengthen rows written by the new
-- hosted connector surface.

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
       WHERE customer_workspace.workspace_id = $1
         AND customer_workspace.workspace_host_id = $2
         AND customer_workspace.organization_id =
             NULLIF(current_setting('app.organization_id', true), '')
         AND customer_workspace.id =
             NULLIF(current_setting('app.workspace_id', true), '')
    )
    OR papercusp_auth.workspace_host_support_grant_allows($1, $2)
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
     WHERE workspace_host.workspace_id = $1
       AND workspace_host.connection_id = $2
       AND harness_shared.workspace_host_scope_allows(
         workspace_host.workspace_id,
         workspace_host.id
       )
  )
$function$;

DO $connector_customer_host_key$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'harness_shared.customer_workspaces'::regclass
       AND conname = 'customer_workspaces_connector_binding_uq'
  ) THEN
    ALTER TABLE harness_shared.customer_workspaces
      ADD CONSTRAINT customer_workspaces_connector_binding_uq
      UNIQUE (workspace_id, organization_id, id, workspace_host_id);
  END IF;
END
$connector_customer_host_key$;

DO $connector_customer_host_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'papercusp_auth.hosted_workspace_connectors'::regclass
       AND conname = 'hosted_workspace_connectors_customer_host_fk'
  ) THEN
    ALTER TABLE papercusp_auth.hosted_workspace_connectors
      ADD CONSTRAINT hosted_workspace_connectors_customer_host_fk
      FOREIGN KEY (
        control_workspace_id,
        organization_id,
        customer_workspace_id,
        host_id
      )
      REFERENCES harness_shared.customer_workspaces (
        workspace_id,
        organization_id,
        id,
        workspace_host_id
      );
  END IF;
END
$connector_customer_host_fk$;

-- Migration 978 meant this trigger to constrain writes only while the
-- transaction had actually entered hosted_service. `pg_has_role(..., 'USAGE')`
-- also matches the admin/application roles that are merely allowed to SET ROLE,
-- so it blocked Papercusp-authoritative member-management role changes. Test the
-- active role identity, not membership in the role graph.
CREATE OR REPLACE FUNCTION papercusp_auth.enforce_hosted_service_membership_reduction()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  old_rank integer;
  new_rank integer;
BEGIN
  IF current_user <> 'hosted_service' THEN
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

DO $hosted_boundary_repair_postcondition$
BEGIN
  IF position(
       'customer_workspace.workspace_host_id = $2'
       IN pg_get_functiondef(
         'harness_shared.workspace_host_scope_allows(text,text)'::regprocedure
       )
     ) = 0 THEN
    RAISE EXCEPTION '1126: workspace-host scope function does not bind its host argument positionally';
  END IF;
  IF position(
       'workspace_host.connection_id = $2'
       IN pg_get_functiondef(
         'harness_shared.workspace_host_connection_scope_allows(text,text)'::regprocedure
       )
     ) = 0 THEN
    RAISE EXCEPTION '1126: connection scope function does not bind its connection argument positionally';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'papercusp_auth.hosted_workspace_connectors'::regclass
       AND conname = 'hosted_workspace_connectors_customer_host_fk'
       AND contype = 'f'
  ) THEN
    RAISE EXCEPTION '1126: exact connector customer/host foreign key is absent';
  END IF;
  IF position(
       'IF current_user <> ''hosted_service'' THEN'
       IN pg_get_functiondef(
         'papercusp_auth.enforce_hosted_service_membership_reduction()'::regprocedure
       )
     ) = 0 THEN
    RAISE EXCEPTION '1126: membership reduction trigger still widens hosted_service by role membership';
  END IF;
END
$hosted_boundary_repair_postcondition$;
