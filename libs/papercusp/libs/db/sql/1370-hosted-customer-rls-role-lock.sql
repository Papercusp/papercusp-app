-- Migration 1370 — reapply hosted role reconciliation with catalog serialization.
-- Migration 978 was applied before its role-catalog lock was added. The only
-- executable delta since that applied version is this role block; the rest of
-- 978 already matches the recorded application. Replaying this block applies
-- the intended serialization without replaying unrelated policy changes.
-- Repair for EI-25183160168061907; lock rationale from WI-10006171.
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

  -- Roles live in a cluster-global catalog even when each replay has its own
  -- database. Database-local advisory locks cannot protect them. Serialize
  -- catalog writers before checking or normalizing roles; this relation lock
  -- also conflicts with ordinary ALTER ROLE in a different database.
  IF is_super THEN
    LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;
  END IF;

  FOREACH target_role IN ARRAY
    ARRAY['hosted_owner', 'hosted_app', 'hosted_service']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      IF NOT can_create THEN
        RAISE EXCEPTION
          'migration 1370: role % does not exist and migration user % lacks CREATEROLE',
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

  -- Check on every run that hosted roles cannot bypass the FORCE RLS boundary.
  SELECT string_agg(rolname, ', ' ORDER BY rolname)
    INTO unsafe
    FROM pg_roles
   WHERE rolname IN ('hosted_owner', 'hosted_app', 'hosted_service')
     AND (rolsuper OR rolbypassrls OR rolreplication OR rolcanlogin
          OR rolcreatedb OR rolcreaterole OR rolinherit);
  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 1370: hosted_* role(s) carry unsafe attributes: %', unsafe
      USING HINT =
        'Re-stamp as a superuser: ALTER ROLE <role> ' || attrs || ';';
  END IF;
END
$hosted_roles$;
