-- 545-coord-event-log-messages-ts-idx.sql
--
-- WI-3825 (LIVE-PINNED 2026-07-10 by su-4dc3b while chasing P-059): readInbox's
-- PG fast path (packages/operator-core/lib/agent-tools/coordination/messages.ts)
-- runs an UNBOUNDED scan of the whole `messages` surface on EVERY call — no
-- since/id predicate, no LIMIT — filtering since_ts/limit/kinds in JS instead.
-- `harness_shared.coord_event_log`'s existing `coord_event_log_surface_id`
-- index is (workspace_id, surface, id): since almost the WHOLE table matches
-- (workspace_id, surface='messages') alone, that prefix gives the planner
-- near-zero selectivity, so it correctly falls back to a Parallel Seq Scan
-- for every call.
--
-- Live-verified evidence (2026-07-10): EXPLAIN ANALYZE shows a Parallel Seq
-- Scan (3 workers, ~382MB touched) per call; pg_stat_user_tables shows
-- seq_scan=209,335 / seq_tup_read=16.7B against only 98,961 live rows;
-- pg_stat_statements attributes ~79h of cumulative DB CPU to this query
-- family (150,320 calls, mean 918ms), saturating the bg-host's PG pool and
-- starving the substrate outbox-drain (WI-3619's 15s stage-stall detector).
--
-- This index adds the missing SELECTIVE column (`ts`, monotonic with `id` —
-- both are set at INSERT time, `ts` via `DEFAULT now()`; NOT the same field
-- as `body->>'ts'`, the client-stamped envelope time the app-level
-- `filterInbox` filters on, which can trail the DB insert under load) so a
-- since-bounded read (readInbox's paired code fix) can seek instead of
-- scanning the full surface. Partial (`WHERE surface = 'messages'`): this is
-- the one hot surface driving the bug; scoping keeps the index small and out
-- of the way of the other (much smaller) surfaces.
--
-- Idempotent (IF NOT EXISTS); no top-level BEGIN/COMMIT (the runner wraps
-- each file in its own transaction) — non-concurrent, matching the
-- established precedent for this same table (see
-- 543-coord-event-log-msg-id-index.sql): migrations apply at boot/provision
-- before load, and IF NOT EXISTS is a no-op wherever the index already
-- exists. ~99k rows total in the table today — a non-concurrent build here
-- is a sub-second operation, not a meaningful lock-hold risk.

CREATE INDEX IF NOT EXISTS coord_event_log_messages_ts_idx
  ON harness_shared.coord_event_log (workspace_id, ts, id)
  WHERE surface = 'messages';
