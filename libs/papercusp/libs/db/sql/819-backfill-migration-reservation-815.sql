-- 819-backfill-migration-reservation-815.sql
--
-- WI-38350 / WI-38348: migration 815-expose-claim-spec-fields-on-engineer-issues-view.sql
-- (EI-20288042426947475) was hand-numbered rather than allocated via
-- `node scripts/next-migration.mjs`, so it landed on disk and was applied
-- (2026-08-12T23:05:13Z) with no harness_shared.migration_reservations row.
--
-- lint:migrations check 7 fails any on-disk number >= ENFORCED_FROM (494) that
-- lacks a reservation row. That red held the green-checkpoint gate for candidate
-- ad13962d (main pinned at e16f9529) AND failed the 0.0.16-alpha release cut
-- preflight, so it blocked every agent's release, not just its author's.
--
-- 815 is already APPLIED and therefore immutable — it cannot be renumbered.
-- There is no number collision: exactly one 815-* file exists on disk and
-- schema_migrations has a single 815 row. Only the ledger row is absent, so the
-- honest repair is to record the number as taken. This makes the invariant
-- TRUE again rather than suppressing the check: 816+ stay fully enforced.
--
-- Third occurrence of this class (795/796/805 were repaired the same way by
-- 807-backfill-migration-reservations-ei20224121418388370.sql, whose shape this
-- migration follows). The backfill is the REPAIR, not the durable fix — nothing
-- yet prevents the next hand-numbered migration from landing. Root-cause guard
-- tracked separately on WI-38350.
--
-- The migration runner wraps this file in one transaction. ON CONFLICT keeps the
-- repair idempotent across databases that already received a manual backfill.

INSERT INTO harness_shared.migration_reservations
  (num, filename, reserved_by, intent, reserved_at)
VALUES
  (815, '815-expose-claim-spec-fields-on-engineer-issues-view.sql', 'backfill-wi38350',
   'backfilled: applied without a db:next-migration reservation row (EI-20288042426947475, repaired under WI-38350/WI-38348)', now())
ON CONFLICT (num) DO NOTHING;
