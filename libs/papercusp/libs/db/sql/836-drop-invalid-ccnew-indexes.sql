-- 836 — Drop the invalid `_ccnew` indexes left behind by interrupted REINDEX CONCURRENTLY.
--
-- WHAT THESE ARE. When `REINDEX CONCURRENTLY` is interrupted (operator restart, lock
-- timeout, SIGTERM), Postgres leaves the half-built replacement behind as
-- `<original>_ccnew`. Measured on this box 2026-08-16 (WI-38449 / P-013), 8 such indexes
-- existed, every one of them:
--     indisvalid = false   -- the planner will NEVER use it for a read
--     indisready = true    -- but every INSERT/UPDATE still maintains it
--     idx_scan   = 0       -- confirming zero reads, since stats began
--
-- That combination is the worst of both: pure write amplification for no read benefit,
-- and it sits on the hottest write tables in the schema. The population observed at
-- 2026-08-16T08:45Z was:
--
--     route_invocations_ws_time_idx_ccnew      719 MB   (table ~14.9M rows)
--     tool_invocations_quota_idx_ccnew         268 MB   (table ~2.4M rows)
--     test_runs_file_path_idx_ccnew            111 MB   (table ~671k rows)
--     shared_presence_{pkey,recent,user,pot_recent,fleet_recent}_idx_ccnew
--                                              8 kB each, but shared_presence is written
--                                              on every heartbeat from ~96 live agents
--     ------------------------------------------------------------------
--     ~1.1 GB at that instant
--
-- ⚠ THAT LIST IS AN OBSERVATION, NOT THIS MIGRATION'S TARGET SET. The population is
-- genuinely dynamic: re-measured ~75 minutes later (2026-08-16T10:00Z) only ONE of those
-- eight was still present (test_runs_file_path_idx_ccnew, by then 65 MB) — the other seven
-- had been cleaned up in the interim. That is exactly why the body below SELECTS the
-- invalid `_ccnew` set at apply time instead of naming eight indexes: hardcoding the
-- observed list would half-fail against whatever the set actually is when this runs, and
-- would go stale again before it ever applied. On a database with no residue left, this
-- migration is a clean no-op.
--
-- WHY A PLAIN `DROP INDEX` AND NOT `DROP INDEX CONCURRENTLY`. The migration runner applies
-- each file as a single `BEGIN; <ddl>; COMMIT;` (db-boot-migrate.ts), and
-- DROP INDEX CONCURRENTLY cannot run inside a transaction block. A plain DROP is
-- acceptable here precisely BECAUSE these indexes are invalid: no query plan references
-- them, so dropping them cannot change any plan or degrade any read. The runner sets
-- lock_timeout = 15s and is continueOnError, so if the ACCESS EXCLUSIVE lock cannot be
-- taken promptly this aborts and is simply retried on the next boot rather than queuing
-- in front of live traffic.
--
-- WHY THE GUARDS BELOW ARE NOT OPTIONAL. A `_ccnew` index is ALSO what a *currently
-- running* REINDEX CONCURRENTLY creates — it is invalid only until that reindex finishes.
-- Dropping one out from under a live reindex would sabotage it. So this migration:
--   (a) refuses to do anything at all while any backend is running a REINDEX, and
--   (b) re-checks `indisvalid = false` for each index at drop time, inside the same
--       transaction, so a valid index can never be dropped by name-matching alone.
-- Both make this safe to re-run: it is idempotent and self-limiting, and on a database
-- with no such residue it is a no-op.
--
-- FORWARD-COMPAT: the currently-deployed release cannot be using any of these, because
-- they are INVALID (`indisvalid = false`) — and that is a property Postgres enforces, not
-- one this migration is asserting. An invalid index is excluded from planning entirely, so
-- no deployed query can have a plan that references it, and it is likewise ineligible as
-- an `ON CONFLICT` arbiter (arbiter inference considers only valid indexes — the
-- EI-18797473716313783 failure mode needs a VALID unique index, which by definition these
-- are not). Their `idx_scan = 0` since stats began corroborates this from the other side.
-- The VALID originals they were meant to replace (route_invocations_ws_time_idx,
-- tool_invocations_quota_idx, test_runs_file_path_idx, and the shared_presence set) all
-- remain in place and untouched — this migration drops only the `_ccnew` residue, so every
-- index the deployed release can actually reach still exists afterwards. There is
-- therefore nothing to expand/contract: this is pure dead-weight removal.

DO $$
DECLARE
  r            record;
  reindex_busy int;
  dropped      int := 0;
  freed        bigint := 0;
BEGIN
  -- (a) Never race a live REINDEX CONCURRENTLY: its in-progress _ccnew is invalid too.
  SELECT count(*) INTO reindex_busy
  FROM pg_stat_activity
  WHERE pid <> pg_backend_pid()
    AND state = 'active'
    AND query ~* '^\s*reindex';

  IF reindex_busy > 0 THEN
    RAISE NOTICE
      'migration 836: SKIPPED — % backend(s) are running REINDEX; their _ccnew indexes are legitimately invalid right now. Re-run this migration later.',
      reindex_busy;
    RETURN;
  END IF;

  -- (b) Only ever touch indexes that are STILL invalid at this moment, in this txn.
  FOR r IN
    SELECT n.nspname  AS schema_name,
           c.relname  AS index_name,
           pg_relation_size(x.indexrelid) AS bytes
    FROM pg_index x
    JOIN pg_class     c ON c.oid = x.indexrelid
    JOIN pg_class     t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'harness_shared'
      AND c.relname LIKE '%\_ccnew%'
      AND x.indisvalid = false
    ORDER BY pg_relation_size(x.indexrelid) DESC
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', r.schema_name, r.index_name);
    dropped := dropped + 1;
    freed   := freed + r.bytes;
    RAISE NOTICE 'migration 836: dropped invalid index %.% (%)',
      r.schema_name, r.index_name, pg_size_pretty(r.bytes);
  END LOOP;

  RAISE NOTICE 'migration 836: dropped % invalid _ccnew index(es), reclaiming %',
    dropped, pg_size_pretty(freed);
END
$$;
