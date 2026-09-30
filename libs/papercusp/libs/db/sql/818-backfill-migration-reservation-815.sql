-- 818-backfill-migration-reservation-815.sql
--
-- WI-38348: migration 815 was hand-numbered rather than allocated through
-- `node scripts/next-migration.mjs`, so it reached disk and was applied
-- (2026-08-12T23:05:13Z) with no row in harness_shared.migration_reservations.
-- lint:migrations check 5 (unreserved number ≥ ENFORCED_FROM) therefore fails,
-- and because that lint is a release-cut preflight it red-pins EVERY agent's
-- release, not just the one that noticed.
--
-- An applied migration is immutable — it cannot be renumbered through the
-- allocator after the fact — so backfilling the ledger row is the only
-- available remedy. Same shape and reasoning as
-- 807-backfill-migration-reservations-ei20224121418388370.sql, which repaired
-- 795/796/805 for the identical reason.
--
-- The migration runner wraps this file in one transaction. ON CONFLICT keeps
-- the repair idempotent across databases that already received a manual
-- backfill (or that never saw the unreserved file at all).

INSERT INTO harness_shared.migration_reservations
  (num, filename, reserved_by, intent, reserved_at)
VALUES
  (815, '815-expose-claim-spec-fields-on-engineer-issues-view.sql', 'backfill-wi38348',
   'backfilled: applied without a db:next-migration reservation row (WI-38348)', now())
ON CONFLICT (num) DO NOTHING;
