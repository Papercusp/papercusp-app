-- 807-backfill-migration-reservations-ei20224121418388370.sql.DRAFT
--
-- EI-20224121418388370: migrations 795, 796, and 805 were hand-picked before
-- reservation discipline was enforced. They are already applied and therefore
-- immutable; backfill their ledger rows once so lint:migrations can distinguish
-- acknowledged history from a newly unreserved migration number.
--
-- The migration runner wraps this file in one transaction. ON CONFLICT keeps the
-- repair idempotent across databases that already received a manual backfill.

INSERT INTO harness_shared.migration_reservations
  (num, filename, reserved_by, intent, reserved_at)
VALUES
  (795, '795-agent-facts-volatile-measurements.sql', 'backfill-ei20224121418388370',
   'backfilled: applied without a db:next-migration reservation row (EI-20224121418388370)', now()),
  (796, '796-conversation-supersession.sql', 'backfill-ei20224121418388370',
   'backfilled: applied without a db:next-migration reservation row (EI-20224121418388370)', now()),
  (805, '805-flush-gate-refusal-marker.sql', 'backfill-ei20224121418388370',
   'backfilled: applied without a db:next-migration reservation row (EI-20224121418388370)', now())
ON CONFLICT (num) DO NOTHING;
