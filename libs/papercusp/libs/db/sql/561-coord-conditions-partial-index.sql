-- Migration 561 — partial index for readConditionEnvelopes (coord:conditions) —
-- EI-9374 (coord-system-e2e-testing-2026-06-10 P-013 furnace watchdog).
--
-- packages/operator-core/lib/agent-tools/coordination/tools/conditions.ts's
-- readConditionEnvelopes() runs, on EVERY `coord:conditions` call:
--
--   SELECT body FROM harness_shared.coord_event_log
--    WHERE workspace_id = $1 AND surface = 'messages'
--      AND (body ? 'condition_key' OR body ? 'resolves_condition')
--    ORDER BY id ASC
--
-- with NO LIMIT and NO ts/id lower bound (unlike readInbox's WI-3825 fast path,
-- which caps at INBOX_FAST_PATH_ROW_CAP). Correctness requires the FULL history
-- (first_seen/alarm_count derive from every condition-carrying envelope ever
-- written), so a LIMIT would silently drop old still-open conditions — the fix
-- has to be an index, not a row cap.
--
-- Confirmed live in pg_stat_statements (queryid -5934058039784757788, matching
-- this exact predicate): 2792 calls / 8525ms mean exec / ~6.6 cumulative hours
-- of DB time within an 18.5h window — a full sequential scan of the `messages`
-- surface (56,571 rows) on every call, even though condition-carrying rows are
-- a tiny sliver (780 of 56,571 ≈ 1.4%, confirmed live 2026-07-10).
--
-- Fix: a partial index whose predicate matches the query's WHERE clause
-- EXACTLY, so Postgres can satisfy it as an index-only-ish scan over just the
-- ~1.4% of rows that match, instead of evaluating the jsonb `?` predicate
-- row-by-row across the whole surface. Non-CONCURRENTLY is safe here — the
-- whole table is a modest 102,129 rows (all surfaces), so the build is a
-- sub-second SHARE-lock window, not a stall risk.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'harness_shared' AND indexname = 'coord_event_log_conditions_idx'
  ) THEN
    CREATE INDEX coord_event_log_conditions_idx
      ON harness_shared.coord_event_log (workspace_id, id)
      WHERE surface = 'messages' AND (body ? 'condition_key' OR body ? 'resolves_condition');
  END IF;
END $$;
