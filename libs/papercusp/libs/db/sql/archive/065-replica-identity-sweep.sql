-- 065-replica-identity-sweep.sql
--
-- Recovery sweep: 119+ harness_shared tables are in the zero_harness
-- publication AND lack a PRIMARY KEY AND use default replica identity.
-- Any UPDATE or DELETE on these throws:
--   "cannot update/delete from table because it does not have a replica
--    identity and publishes ..."
--
-- The operator-dev log fires this error continuously from sweep workers
-- on operator_scan_locks, operator_claims, agent_runs_consolidated,
-- and many more. Same root cause as 064 fixed for users/sessions/prefs.
--
-- Strategy: set REPLICA IDENTITY FULL on every affected table. FULL is
-- the safe blanket fix — PG emits the complete OLD row on UPDATE/DELETE
-- to the publication. Cost: bandwidth + a small CPU bump per write,
-- mostly negligible for these tables which are low-volume.
--
-- Adding REAL primary keys per table would be cleaner but requires
-- per-table schema knowledge and migration ordering. FULL is the safe,
-- idempotent blanket fix; later individual migrations can swap FULL
-- for DEFAULT after adding a PK on a case-by-case basis.
--
-- Idempotent: ALTER TABLE ... REPLICA IDENTITY FULL on a table already
-- at FULL is a no-op. Re-running the migration produces no errors.

DO LANGUAGE plpgsql $body$
DECLARE
  r record;
  fixed_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname || '.' || c.relname AS qualname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r'
       AND n.nspname = 'harness_shared'
       AND EXISTS(SELECT 1 FROM pg_publication_tables
                   WHERE schemaname=n.nspname AND tablename=c.relname)
       AND NOT EXISTS(SELECT 1 FROM pg_constraint
                       WHERE conrelid=c.oid AND contype='p')
       AND c.relreplident = 'd'
  LOOP
    EXECUTE format('ALTER TABLE %s REPLICA IDENTITY FULL', r.qualname);
    fixed_count := fixed_count + 1;
  END LOOP;
  RAISE NOTICE 'replica-identity sweep: % tables set to FULL', fixed_count;
END
$body$;
