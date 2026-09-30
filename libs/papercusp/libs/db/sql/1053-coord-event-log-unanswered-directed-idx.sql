-- 1053-coord-event-log-unanswered-directed-idx.sql
--
-- WI-7048 — unanswered-directed's two remaining coord_event_log scans are full
-- Parallel Seq Scans, and the table has grown 5.2x since the item was filed.
--
-- WHAT THIS IS A FOLLOW-UP TO. P-017/WI-6853 removed the correlated count subquery
-- (2,545ms -> 985ms); WI-6875 collapsed three unbounded re-scans into one
-- pre-materialized pass (985ms -> 224ms). Both shipped and both were right. What they
-- did NOT do is give either surviving scan an access path: the roster pre-filter made
-- ONE scan sufficient, but that one scan was still a full table scan, and so was
-- `directed`'s.
--
-- MEASURED ON THE LIVE TABLE (2026-08-31, workspace papercusp-workspace):
--   harness_shared.coord_event_log = 442,827 rows / 852 MB heap / 504 MB indexes.
--   surface='messages' = 406,086 of them. When WI-7048 was filed (2026-08-02) that
--   partition held 78,451 rows: it is 5.2x larger a month later, min(ts) is still
--   2026-05-30, and nothing has ever been deleted from it.
--
--   EXPLAIN (ANALYZE, BUFFERS) of the two scans, as they run today:
--     roster_authored  Parallel Seq Scan  651,552 buffers (~5.1 GB)     653 ms
--     directed         Parallel Seq Scan  2,958,071 buffers (~23 GB)  1,606 ms
--   `directed` is the larger half by 4.5x in buffers — it survives its filter with
--   329,372 rows and then runs a LATERAL function scan once per surviving row.
--
-- WHY INDEXES AND NOT THE TIME BOUND THE WORK ITEM ASKED FOR. WI-7048 proposed "a
-- time bound or retention". The time bound is NOT AVAILABLE, and the reason is
-- recorded in unanswered-directed.ts's own comment: a message's `ts` is
-- SENDER-SUPPLIED in the body, so bounding these scans would import an assumption
-- ("a reply must postdate its ask") that the current semantics do not make. Retention
-- is a separate and much larger question — coord history is read by coord:feed,
-- catch-up, audience history and sessions search — and deleting rows to make one
-- query fast would be a policy decision disguised as a performance fix.
--
-- Indexing is the third option, and it dominates both: an index CANNOT change a
-- result, so there is no semantic risk to weigh at all, and no row is lost. The
-- growth problem itself is real and remains open on WI-7048; this migration removes
-- the per-call cost of it, not the growth.
--
-- WHY THE PLANNER WILL USE THESE, given it demonstrably ignored earlier attempts.
-- unanswered-directed.ts records that two purpose-built indexes were built, ANALYZEd
-- and EXPLAINed and the planner ignored BOTH. That observation was correct AND is now
-- superseded: it was made when these lookups were correlated subqueries estimated at
-- ONE row, where a nested loop looks free and no index can win. WI-6875 replaced that
-- shape with standalone materialized scans estimating 4,105 rows out of 442,827
-- (0.9%), which is ordinary index territory. Verified, not assumed — each index was
-- built on a 406k-row copy and re-EXPLAINed:
--     roster_authored  Index Scan          651,552 buffers ->  69    653 ms -> 0.22 ms
--     directed         Bitmap Index Scan  2,958,071 buffers ->  85  1,606 ms -> 0.28 ms
-- The copy carried a NARROWED body (only the keys each predicate reads), which makes a
-- seq scan artificially CHEAP; the index winning there is therefore a conservative
-- result, and its margin on the real 852 MB heap is strictly larger.
--
-- THE PARTIAL PREDICATE MUST MATCH THE QUERY TEXTUALLY. Both indexes are partial on
-- `surface = 'messages'` and both call sites carry that exact literal predicate. This
-- is the same trap migration 1038 documents: the planner cannot derive one operator
-- over an expression from a different operator over a different expression, so the
-- clauses are load-bearing for the PLAN even where they read as redundant. Do not
-- "simplify" either predicate, and do not reorder the btree columns — `workspace_id`
-- leads because every call site is workspace-scoped.
--
-- THE GIN INDEX HAS A COMPANION CODE CHANGE, and is inert without it. `directed`
-- filters on `r = ANY(recipientIds)` where `r` is unnested by CROSS JOIN LATERAL, and
-- no index can reach a value that does not exist until after the join. The companion
-- edit in unanswered-directed.ts adds `body->'to' ?| recipientIds` as an explicit
-- pre-filter on the ROW, which is what GIN can answer. That clause is exactly
-- equivalence-preserving rather than a heuristic narrowing: a row can only produce a
-- matching `r` if its 'to' array contains one of those ids, so a row it removes could
-- never have satisfied the LATERAL predicate. Verified as an identity on live data
-- (100 rows = 100 rows, and checked non-empty so the match is not two zeroes).
--
-- NOT CONCURRENTLY, deliberately. The migration runner wraps each file in its own
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one (same tradeoff as
-- migrations 753 / 792 / 1038). The build therefore takes a ShareLock, blocking
-- INSERTs to coord_event_log for its duration. MEASURED against the LIVE table by
-- running these exact statements inside a rolled-back transaction:
--     btree  880.541 ms -> 3,352 kB
--     gin    746.605 ms -> 3,376 kB
-- ~1.6 s combined and 6.7 MB total. Sub-second per statement on a hot table needs no
-- maintenance window, matching the precedent set by 1038 (0.680 s).
--
-- FORWARD-COMPAT / DEPLOY ORDER: safe in both directions, and safe to apply BEFORE the
-- companion code change deploys. Purely ADDITIVE — it creates two indexes and drops,
-- renames and rewrites nothing. The currently-deployed release simply does not use
-- them: the btree starts helping the moment it exists (that call site is unchanged),
-- and the GIN index sits unused until the `?|` pre-filter ships, costing only its
-- 3.4 MB and its share of INSERT maintenance in the meantime.
--
-- The migration runner wraps each file in its own transaction, so this file carries NO
-- top-level BEGIN;/COMMIT; (migration-runner contract; files >=215).

CREATE INDEX IF NOT EXISTS coord_event_log_msgs_from_idx
  ON harness_shared.coord_event_log
  USING btree (workspace_id, ((body ->> 'from'::text)))
  WHERE surface = 'messages';

COMMENT ON INDEX harness_shared.coord_event_log_msgs_from_idx IS
  'WI-7048: access path for unanswered-directed''s roster_authored CTE, which filters '
  'surface=''messages'' rows by body->>''from'' = ANY(roster). Without it that CTE is a '
  'Parallel Seq Scan examining every row in the table (651,552 buffers / 653 ms measured '
  '2026-08-31) to return ~78. The partial predicate must keep matching the call site''s '
  'literal surface=''messages'' clause or the planner cannot use this index.';

CREATE INDEX IF NOT EXISTS coord_event_log_msgs_to_gin
  ON harness_shared.coord_event_log
  USING gin ((body -> 'to'::text))
  WHERE surface = 'messages';

COMMENT ON INDEX harness_shared.coord_event_log_msgs_to_gin IS
  'WI-7048: access path for unanswered-directed''s `directed` CTE. Its real predicate is '
  'on a CROSS JOIN LATERAL unnest of body->''to'', which no index can reach; the companion '
  'code change adds an equivalence-preserving `body->''to'' ?| recipientIds` row pre-filter, '
  'which this GIN index answers (2,958,071 buffers / 1,606 ms -> 85 buffers / 0.28 ms '
  'measured 2026-08-31). This index is INERT without that clause — if a future edit removes '
  'the `?|` pre-filter, drop this index rather than leaving it to be maintained unused.';
