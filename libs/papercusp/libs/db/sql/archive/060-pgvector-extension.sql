-- 060-pgvector-extension.sql
--
-- Make pgvector available on the harness database so mem0 (and any
-- future embedding-driven feature) can use a real vector store instead
-- of mem0's volatile in-memory fallback.
--
-- Requires: pgvector compiled against PostgreSQL 18 to be present in
-- the server's pkglibdir + extension share dir. For the embedded-pg
-- binary we ship, that means vector.so + vector*.sql files copied into:
--   node_modules/@embedded-postgres/linux-x64/native/lib/postgresql/
--   node_modules/@embedded-postgres/linux-x64/native/share/postgresql/extension/
--
-- See bin/install-pgvector-into-embedded.sh for the dev-machine copy
-- step. Native (non-embedded) PG installs satisfy this requirement via
-- `apt install postgresql-18-pgvector`.
--
-- If the .so is missing this CREATE EXTENSION fails — that is fine and
-- intended. mem0-client.ts catches the failure and falls back to its
-- in-memory provider so the rest of the operator keeps booting.

-- Wrap in a DO block so missing pgvector.so doesn't abort the migration
-- transaction (which would cause schema_migrations to never record this
-- file, looping the failed CREATE EXTENSION on every subsequent boot).
-- Uses named dollar-quote ($body$) instead of unnamed ($$) to be robust
-- against any tool that mangles repeated `$` (some bash heredocs do).
DO LANGUAGE plpgsql $body$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension not available on this server (%); mem0 will use in-memory fallback.', SQLERRM;
END
$body$;
