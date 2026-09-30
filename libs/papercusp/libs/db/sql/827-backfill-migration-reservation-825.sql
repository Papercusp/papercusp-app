-- 827-backfill-migration-reservation-825.sql.DRAFT
--
-- WI-38460: migration 825-verified-wait-producer-health.sql was added without
-- first allocating its number through db:next-migration. The staging database
-- applied it at 2026-08-13T11:42:42Z, so the applied migration is immutable and
-- cannot honestly be renumbered after the fact.
--
-- The schema_migrations ledger has exactly one 825 row and the tree has exactly
-- one 825-* file. The missing state is therefore only the allocator provenance
-- row required by lint:migrations. Record that history explicitly rather than
-- weakening the invariant for later migrations.
--
-- The migration runner wraps this file in one transaction. ON CONFLICT keeps
-- the repair idempotent for databases where an operator already repaired the
-- reservation manually.

INSERT INTO harness_shared.migration_reservations
  (num, filename, reserved_by, intent, reserved_at)
VALUES
  (825, '825-verified-wait-producer-health.sql', 'backfill-wi38460',
   'backfilled: applied without a db:next-migration reservation row (repaired under WI-38460)', now())
ON CONFLICT (num) DO NOTHING;
