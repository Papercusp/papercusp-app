-- Migration 997 — hosted_app role membership for the hosted request path
-- byoc-cloud-workspaces-gcp-aws-azure-2026-08-22 P-037 / WI-40505.
-- (Depends on 978, which provisions the hosted_* roles and the FORCE RLS boundary.)
--
-- WHY THIS EXISTS
-- Migration 978 creates hosted_app as NOLOGIN NOINHERIT and re-verifies on EVERY
-- run that no hosted_* role can log in. The hosted request path therefore cannot
-- open a connection AS hosted_app: the role is designed to be ASSUMED, never
-- connected as. libs/db/src/tenant-context.ts consequently has to reach it with
-- `SET LOCAL ROLE hosted_app`, and that requires harness_app -- the application
-- pool role built in libs/db/src/connection.ts -- to be a MEMBER of hosted_app.
-- Without this grant the hosted path fails closed at runtime with
-- `permission denied to set role "hosted_app"`.
--
-- WHY `WITH INHERIT FALSE` IS LOAD-BEARING, NOT A STYLE CHOICE
-- harness_app has rolinherit = true (measured on this cluster). A DEFAULT
-- membership would therefore hand EVERY ordinary harness_app query hosted_app's
-- table privileges AMBIENTLY, with no SET ROLE anywhere -- dissolving the exact
-- FORCE RLS boundary migration 978 exists to build, silently and repo-wide.
-- `WITH INHERIT FALSE` grants only the ability to ASSUME the role: privileges
-- arrive if and only if a transaction explicitly switches into it, and SET LOCAL
-- drops them again at COMMIT/ROLLBACK so a pooled connection cannot retain them.
-- Requires PostgreSQL 16+ (measured on this cluster: 18.4).
--
-- Idempotent: the membership is re-stamped whenever this migration user is
-- permitted to grant it, and the security post-condition is re-checked on EVERY
-- run at EVERY privilege level -- so an unsafe INHERIT membership is never
-- silently tolerated, exactly as 978 treats unsafe role attributes.
--
-- Not destructive DDL: this migration only adds a role membership, so the
-- currently-deployed release keeps working unchanged.

DO $hosted_app_membership$
DECLARE
  can_grant      boolean;
  has_membership boolean;
  inherits       boolean;
  can_set        boolean;
BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION
      'migration 997: GRANT ... WITH INHERIT FALSE requires PostgreSQL 16+, found %',
      current_setting('server_version');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hosted_app') THEN
    RAISE EXCEPTION 'migration 997: role hosted_app is missing -- migration 978 must run first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
    RAISE EXCEPTION 'migration 997: role harness_app is missing';
  END IF;

  -- May THIS migration user grant membership in hosted_app? Superuser, or a role
  -- holding ADMIN OPTION on it (PostgreSQL 16+ gives the creating role ADMIN
  -- OPTION automatically, so the user that ran 978 normally qualifies). When it
  -- may not, we degrade from WRITING to CHECKING -- the same posture 978 takes --
  -- so an under-privileged migration user cannot silently skip the boundary.
  SELECT r.rolsuper
      OR EXISTS (
           SELECT 1
             FROM pg_auth_members m
             JOIN pg_roles g   ON g.oid   = m.roleid
             JOIN pg_roles mem ON mem.oid = m.member
            WHERE g.rolname = 'hosted_app'
              AND mem.rolname = current_user
              AND m.admin_option
         )
    INTO can_grant
    FROM pg_roles r
   WHERE r.rolname = current_user;

  IF can_grant THEN
    -- Re-stamped every run: a membership previously granted with INHERIT TRUE is
    -- corrected here rather than merely reported.
    EXECUTE 'GRANT hosted_app TO harness_app WITH INHERIT FALSE';
    EXECUTE 'GRANT hosted_app TO harness_app WITH SET TRUE';
  END IF;

  SELECT TRUE, m.inherit_option, m.set_option
    INTO has_membership, inherits, can_set
    FROM pg_auth_members m
    JOIN pg_roles g   ON g.oid   = m.roleid
    JOIN pg_roles mem ON mem.oid = m.member
   WHERE g.rolname = 'hosted_app'
     AND mem.rolname = 'harness_app';

  -- Post-conditions, checked on EVERY run at EVERY privilege level.
  --
  -- THE SEVERITY SPLIT IS DELIBERATE, and it is the whole reason this block is
  -- shaped this way. hosted_app is normally created by a SUPERUSER (978 degrades
  -- to verify-only when it cannot create roles), which means the ordinary
  -- migration user -- harness_admin here -- holds neither SUPERUSER nor ADMIN
  -- OPTION on hosted_app and simply CANNOT perform this grant. Raising an
  -- exception for that condition would fail on every boot and block the entire
  -- migration ledger behind this file, which is exactly the outage 978 records
  -- in EI-21547015064885986. So:
  --
  --   * A MISSING membership is already fail-CLOSED at runtime (the hosted path
  --     gets `permission denied to set role`, it does not leak). It is reported
  --     as a loud WARNING with the exact superuser command, and the ledger is
  --     allowed to proceed.
  --   * An INHERITED membership is a live SECURITY HOLE -- ambient hosted
  --     privileges on every ordinary query -- and is never tolerated at any
  --     privilege level, so it still raises.
  IF NOT COALESCE(has_membership, FALSE) THEN
    RAISE WARNING
      'migration 997: harness_app is not a member of hosted_app, so the hosted request path cannot SET LOCAL ROLE and stays fail-closed'
      USING HINT =
        'Grant it once as a superuser: GRANT hosted_app TO harness_app WITH INHERIT FALSE;';
  ELSIF inherits THEN
    RAISE EXCEPTION
      'migration 997: harness_app inherits hosted_app AMBIENTLY -- every ordinary query would hold hosted privileges with no SET ROLE, defeating the FORCE RLS boundary of migration 978'
      USING HINT =
        'Correct it as a superuser: GRANT hosted_app TO harness_app WITH INHERIT FALSE;';
  ELSIF NOT can_set THEN
    RAISE WARNING
      'migration 997: harness_app may not SET ROLE hosted_app (set_option is false), so the hosted request path stays fail-closed'
      USING HINT =
        'Correct it as a superuser: GRANT hosted_app TO harness_app WITH SET TRUE;';
  END IF;
END
$hosted_app_membership$;
