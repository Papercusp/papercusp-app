-- 1324 — rename harness_shared.trigger_sources to data_sources (EXPAND step).
--
-- Plan enterprise-data-sources-2026-10-01, D-010 / D-014; work item WI-10005063.
-- Migration 1317 extended trigger_sources in place into the data-source record:
-- triggers are now one consumer of it, so the table is renamed to say what it is.
--
-- EXPAND / CONTRACT. The database migrates now, but the operator on :3070 keeps
-- serving the release checkout until green main deploys, and that code still says
-- harness_shared.trigger_sources. So this migration:
--   1. renames the table and every index, constraint, trigger and trigger function
--      whose name carries the trigger_sources prefix to the data_sources prefix;
--   2. leaves behind harness_shared.trigger_sources as an automatically updatable
--      view over data_sources (SELECT, INSERT ... ON CONFLICT ... RETURNING, UPDATE
--      and DELETE all pass through to the base table, and its BEFORE trigger fires),
--      granted exactly like the table was.
-- The CONTRACT step (drop the view) is a later migration, filed as a follow-up of
-- WI-10005063, once the deployed release no longer references the old name.
--
-- FORWARD-COMPAT: the deployed release keeps working because the compat view
-- harness_shared.trigger_sources answers every statement it issues, and its two
-- ON CONFLICT arbiters (source-store.ts) infer the unique index by column tuple
-- (workspace_id, kind, owner_user_id, provider_account_id), never by index or
-- constraint name, so renaming the indexes and constraints is invisible to it.

ALTER TABLE harness_shared.trigger_sources RENAME TO data_sources;

-- Indexes (the primary key index included).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'harness_shared.data_sources'::regclass
       AND c.relname LIKE 'trigger\_sources\_%'
  LOOP
    EXECUTE format('ALTER INDEX harness_shared.%I RENAME TO %I',
                   r.name, 'data_sources_' || substr(r.name, length('trigger_sources_') + 1));
  END LOOP;
END $$;

-- Constraints. Index-backed constraints (the primary key) were renamed with their
-- index above, so only the remaining trigger_sources_* names are left here. PG18
-- also names NOT NULL constraints; they rename the same way.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'harness_shared.data_sources'::regclass
       AND conname LIKE 'trigger\_sources\_%'
  LOOP
    EXECUTE format('ALTER TABLE harness_shared.data_sources RENAME CONSTRAINT %I TO %I',
                   r.conname, 'data_sources_' || substr(r.conname, length('trigger_sources_') + 1));
  END LOOP;
END $$;

ALTER TRIGGER trigger_sources_apply_kind_defaults ON harness_shared.data_sources
  RENAME TO data_sources_apply_kind_defaults;

ALTER FUNCTION harness_shared.trigger_sources_apply_kind_defaults()
  RENAME TO data_sources_apply_kind_defaults;

-- Row-level security policies (trigger_sources_workspace_isolation).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT polname
      FROM pg_policy
     WHERE polrelid = 'harness_shared.data_sources'::regclass
       AND polname LIKE 'trigger\_sources\_%'
  LOOP
    EXECUTE format('ALTER POLICY %I ON harness_shared.data_sources RENAME TO %I',
                   r.polname, 'data_sources_' || substr(r.polname, length('trigger_sources_') + 1));
  END LOOP;
END $$;

-- Compat view for the deployed release (dropped by the CONTRACT migration).
-- security_invoker: the table has row-level security (workspace isolation on
-- app.workspace_id). A default view runs with its OWNER's privileges, and the
-- owner bypasses RLS, so without this the old name would see every workspace's
-- rows. With it, the caller's own RLS applies exactly as it did on the table.
CREATE VIEW harness_shared.trigger_sources
  WITH (security_invoker = true) AS
  SELECT * FROM harness_shared.data_sources;

COMMENT ON VIEW harness_shared.trigger_sources IS
  'EXPAND-phase compat alias for harness_shared.data_sources (migration 1324, WI-10005063). Code must use data_sources; this view is dropped once the deployed release no longer references it.';

-- Mirror the table's grants onto the view, so every role that could use the old
-- table name can still use it, with the same privileges.
DO $$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT grantee, string_agg(privilege_type, ', ') AS privs
      FROM information_schema.role_table_grants
     WHERE table_schema = 'harness_shared'
       AND table_name = 'data_sources'
       AND grantee <> (SELECT pg_get_userbyid(relowner)
                         FROM pg_class
                        WHERE oid = 'harness_shared.data_sources'::regclass)
     GROUP BY grantee
  LOOP
    -- PUBLIC is a keyword, not a role name: quoting it would name a role "PUBLIC".
    EXECUTE format('GRANT %s ON harness_shared.trigger_sources TO %s', g.privs,
                   CASE WHEN g.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g.grantee) END);
  END LOOP;
END $$;
