-- 817-backfill-migration-reservation-815.sql
--
-- WI-38348: migration 815-expose-claim-spec-fields-on-engineer-issues-view.sql was
-- hand-numbered rather than allocated via `node scripts/next-migration.mjs`, so it
-- landed on disk with no harness_shared.migration_reservations row. lint:migrations
-- check 7 fails any on-disk number >=494 lacking one, which red-pins the release-cut
-- preflight for EVERY agent, not just the one that wrote 815. The migration's content
-- is fine and there is no number collision — only the ledger row is absent.
--
-- 815 is already applied and therefore immutable; backfill its ledger row once so the
-- lint can distinguish acknowledged history from a newly unreserved number. Third
-- occurrence of this class (see 807-backfill-migration-reservations-ei20224121418388370.sql,
-- which repaired 795/796/805 the same way). This is a MITIGATION: nothing yet prevents
-- the next hand-numbered migration from landing, so the root-cause guard stays open.
--
-- The migration runner wraps this file in one transaction. ON CONFLICT keeps the repair
-- idempotent across databases that already received a manual backfill.

INSERT INTO harness_shared.migration_reservations
  (num, filename, reserved_by, intent, reserved_at)
VALUES
  (815, '815-expose-claim-spec-fields-on-engineer-issues-view.sql', 'backfill-wi38348',
   'backfilled: applied without a db:next-migration reservation row (WI-38348)', now())
ON CONFLICT (num) DO NOTHING;
