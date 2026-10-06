-- 1327 — rename harness_shared.personal_documents to documents (EXPAND step).
--
-- Plan enterprise-data-sources-2026-10-01, P-014 follow-up; work item WI-10005071.
-- Migration 1316 generalized personal_documents into ONE documents corpus with a
-- scope (personal | organization | pot). It is no longer only personal data, so the
-- table is renamed to say what it is. Same shape as 1324 (trigger_sources ->
-- data_sources).
--
-- EXPAND / CONTRACT. The database migrates now, but the operator on :3070 keeps
-- serving the release checkout until green main deploys, and that code still says
-- harness_shared.personal_documents. So this migration:
--   1. renames the table and every index, constraint and row-level security policy
--      whose name carries the personal_documents prefix to the documents prefix
--      (the table has no triggers, no dependent views, no functions naming it and
--      no publication membership — checked against the live catalog 2026-10-01);
--   2. leaves behind harness_shared.personal_documents as an automatically
--      updatable view over documents (SELECT, INSERT ... ON CONFLICT ... DO UPDATE,
--      UPDATE and DELETE all pass through to the base table), granted exactly like
--      the table was.
-- The CONTRACT step (drop the view) is a later migration, filed as a follow-up of
-- WI-10005071, once the deployed release no longer references the old name.
--
-- FORWARD-COMPAT: the deployed release keeps working because the compat view
-- harness_shared.personal_documents answers every statement it issues. Its upserts
-- (personal-vault/store.ts, data-sources/documents-corpus.ts and
-- chat-retrieval-units.ts) infer their arbiter by column tuple, never ON CONFLICT ON
-- CONSTRAINT, so renaming the indexes and constraints is invisible to them; their
-- DO UPDATE clauses qualify columns as personal_documents.<col>, which is the view
-- name the statement targets. The generated columns scope_key and text_tsv are
-- never written by name, so inserts through the view still compute them.

ALTER TABLE harness_shared.personal_documents RENAME TO documents;

-- Indexes (the primary key and unique-constraint indexes included).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'harness_shared.documents'::regclass
       AND c.relname LIKE 'personal\_documents\_%'
  LOOP
    EXECUTE format('ALTER INDEX harness_shared.%I RENAME TO %I',
                   r.name, 'documents_' || substr(r.name, length('personal_documents_') + 1));
  END LOOP;
END $$;

-- Constraints. Index-backed constraints (primary key, unique) were renamed with
-- their index above, so only the remaining personal_documents_* names are left
-- here: checks, the permission-list foreign key, and PG18's named NOT NULLs.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'harness_shared.documents'::regclass
       AND conname LIKE 'personal\_documents\_%'
  LOOP
    EXECUTE format('ALTER TABLE harness_shared.documents RENAME CONSTRAINT %I TO %I',
                   r.conname, 'documents_' || substr(r.conname, length('personal_documents_') + 1));
  END LOOP;
END $$;

-- Row-level security policies (personal_documents_workspace_isolation).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT polname
      FROM pg_policy
     WHERE polrelid = 'harness_shared.documents'::regclass
       AND polname LIKE 'personal\_documents\_%'
  LOOP
    EXECUTE format('ALTER POLICY %I ON harness_shared.documents RENAME TO %I',
                   r.polname, 'documents_' || substr(r.polname, length('personal_documents_') + 1));
  END LOOP;
END $$;

-- Compat view for the deployed release (dropped by the CONTRACT migration).
-- security_invoker: the table has row-level security (workspace isolation on
-- app.workspace_id). A default view runs with its OWNER's privileges, and the
-- owner bypasses RLS, so without this the old name would see every workspace's
-- rows. With it, the caller's own RLS applies exactly as it did on the table.
CREATE VIEW harness_shared.personal_documents
  WITH (security_invoker = true) AS
  SELECT * FROM harness_shared.documents;

COMMENT ON VIEW harness_shared.personal_documents IS
  'EXPAND-phase compat alias for harness_shared.documents (migration 1327, WI-10005071). Code must use documents; this view is dropped once the deployed release no longer references it.';

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
       AND table_name = 'documents'
       AND grantee <> (SELECT pg_get_userbyid(relowner)
                         FROM pg_class
                        WHERE oid = 'harness_shared.documents'::regclass)
     GROUP BY grantee
  LOOP
    -- PUBLIC is a keyword, not a role name: quoting it would name a role "PUBLIC".
    EXECUTE format('GRANT %s ON harness_shared.personal_documents TO %s', g.privs,
                   CASE WHEN g.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g.grantee) END);
  END LOOP;
END $$;
