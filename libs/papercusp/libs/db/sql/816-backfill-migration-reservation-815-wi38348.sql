-- 816-backfill-migration-reservation-815-wi38348.sql
--
-- WI-38348: migration 815 was hand-numbered rather than allocated through
-- `node scripts/next-migration.mjs` / db:next-migration, so it landed on disk
-- (and was APPLIED at 2026-08-12T23:05:13Z) with no
-- harness_shared.migration_reservations row.
--
-- scripts/lint-migrations.mjs check 7 fails any on-disk number >= ENFORCED_FROM
-- (494) that lacks a reservation row. lint:migrations is a release-cut preflight,
-- so the missing ledger row red-pinned the gate and blocked EVERY agent's release
-- cut, not just the 0.0.16-alpha attempt that first hit it.
--
-- 815 is already applied and therefore immutable, and there is no number
-- collision (exactly one 815-* file on disk); only the ledger row is absent.
-- This follows the 807 precedent: backfill the row once so lint:migrations can
-- distinguish acknowledged history from a newly unreserved migration number.
--
-- The migration runner wraps this file in one transaction. ON CONFLICT keeps the
-- repair idempotent across databases that already received a manual backfill.

INSERT INTO harness_shared.migration_reservations
  (num, filename, reserved_by, intent, reserved_at)
VALUES
  (815, '815-expose-claim-spec-fields-on-engineer-issues-view.sql', 'backfill-wi38348',
   'backfilled: applied without a db:next-migration reservation row (WI-38348)', now())
ON CONFLICT (num) DO NOTHING;
