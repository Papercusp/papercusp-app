-- Migration 792 — quota index must cover 'refused', not just 'ok'
-- (EI-20184794555427363).
--
-- WHY. A tool handler can fail in two ways and only one of them throws. A
-- dispatch-level failure (throw / gate denial) was always recorded with its own
-- status; a SELF-REPORTED refusal — the handler returns normally carrying
-- `isError: true`, e.g. plans:new answering {"error":"similar_exists"} — was
-- recorded as a flat `status='ok', error_code=NULL`, byte-identical to a call
-- that did the work. That made refusals unfalsifiable from the ledger: measured
-- 7 of 81 `plans:new` calls in one 7-day window were refusals recorded as `ok`,
-- which reads as "the tool succeeded and persisted nothing" — a phantom
-- data-loss bug that did not exist. The dispatcher now writes `status='refused'`.
--
-- WHAT THAT BREAKS WITHOUT THIS. Quota is counted off the ledger, and a refusal
-- DOES perform work (handler, gates, often a dedup index search), so it has
-- always counted toward quota and must keep counting — otherwise refusals
-- silently become free and a caller can spin them without limit. So readQuotaState
-- now counts ('ok','refused'). But `tool_invocations_quota_idx` is PARTIAL on
-- `status = 'ok'`, and `status IN ('ok','refused')` does not imply that predicate,
-- so the planner cannot use it. MEASURED on the live 1,038,122-row table, warm:
--
--   WHERE status = 'ok'                 Index Only Scan     0.155 ms       4 buffers
--   WHERE status IN ('ok','refused')    Parallel Seq Scan   179 ms   189,975 buffers
--
-- ~1,150x, five parallel workers, on a query that runs per quota-bearing call.
-- Widening the predicate to match the query restores the index-only scan.
--
-- `INCLUDE (status)` so the narrower `status = 'ok'` reads (the currently-deployed
-- release's quota query, and the tool_invocations_artifacts view) stay INDEX-ONLY
-- too: without it, PG can still prove x='ok' implies x IN ('ok','refused') and use
-- the index, but must recheck status from the heap on every tuple.
--
-- FORWARD-COMPAT: the currently-deployed release only ever writes status='ok' and
-- only ever reads `status = 'ok'`, which the new wider predicate still satisfies
-- (PG proves the implication and, with INCLUDE (status), still serves it index-only) —
-- so the running :3070 release keeps working unchanged against this index while the
-- DB is ahead of it. Nothing is dropped that the old code depends on: the index name,
-- its column list and its access method are unchanged, only the partial predicate widens.
--
-- DEPLOY ORDER IS SAFE IN BOTH DIRECTIONS, deliberately checked because making an
-- existing index MORE partial is a cutover that has already caused a ~4h fleet-wide
-- outage here (EI-18786592200395716). This is the opposite operation — the predicate
-- WIDENS to a superset — and this index is a plain btree used for counting, never a
-- UNIQUE arbiter for ON CONFLICT, which is what that incident actually broke.
--   DB ahead of code (the normal order — migrations auto-apply, code ships after the
--     green gate): old code writes only 'ok' and reads only `status='ok'` — still served,
--     still index-only. See FORWARD-COMPAT above.
--   Code ahead of DB: new code counts ('ok','refused') against the old narrow index, so
--     the planner falls back to the 179ms seq scan measured above — DEGRADED, never wrong,
--     and self-heals the moment this migration applies.
--
-- The swap is DROP+CREATE inside the runner's per-file transaction, so it is atomic
-- to every other session — no window exists in which the index is missing. It is a
-- plain (non-CONCURRENT) build because the runner wraps each file in a transaction
-- and CREATE INDEX CONCURRENTLY cannot run inside one (same tradeoff as migrations
-- 753 and every other index on this table). It takes a ShareLock for the build,
-- blocking telemetry INSERTs for that window: MEASURED at 3.79s for the build against
-- the live 1,038,122-row table (the table is fully cached — 189,975 buffers, all shared
-- HITS, zero reads), by running this exact DROP+CREATE inside a rolled-back transaction.
--
-- VERIFIED (isolated temp-table replica, 300k rows, post-ANALYZE) that the new index is
-- actually CHOSEN for both readers, which is the whole point of the change:
--   WHERE status IN ('ok','refused')   Index Only Scan   0.068 ms
--   WHERE status = 'ok'                Index Only Scan   0.028 ms   <- old release, still index-only
-- ⚠ Do NOT try to confirm this by EXPLAINing inside the same transaction that builds the
-- index: a freshly built index in an uncommitted transaction has no statistics and the
-- planner falls back to a seq scan for BOTH predicates — including `status = 'ok'`, which
-- is index-only in steady state. That reads as "the new index does not work" and is an
-- artifact of the probe, not of the index.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; files >=215).

DROP INDEX IF EXISTS harness_shared.tool_invocations_quota_idx;

CREATE INDEX IF NOT EXISTS tool_invocations_quota_idx
  ON harness_shared.tool_invocations
  USING btree (workspace_id, tool_name, role, window_key)
  INCLUDE (status)
  WHERE (status = ANY (ARRAY['ok'::text, 'refused'::text]));
