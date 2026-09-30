-- 717 — Partial index for Scout's two harness_plans sweeps (WI-6839).
--
-- WHAT THIS FIXES
-- Two Scout statements sweep harness_plans on every tick:
--   packages/operator-core/lib/scout/draft-review-watchdog.ts  (status='draft')
--   packages/operator-core/lib/scout/ready-plan-autostart.ts   (status='ready')
-- Both filter with `content LIKE '%\norigin: scout\n%'` — a LEADING-WILDCARD LIKE
-- against the 71 MB TOASTed `content` column, purely to test a FRONTMATTER field.
-- No index can serve that predicate, so the planner seq-scanned the whole table
-- and detoasted `content` for every row.
--
-- MEASURED (EXPLAIN ANALYZE, BUFFERS, papercusp tenant, 2026-08-02; the index was
-- created inside a transaction and ROLLED BACK to take the after-reading, then
-- verified absent):
--   BEFORE  Seq Scan -> Sort -> Limit
--           Rows Removed by Filter: 999 | Buffers: shared hit=4459 | 92.671 ms
--   AFTER   Index Scan using this index
--           Rows Removed by Filter: 122 | Buffers: shared hit=612 read=3 (615)
--           Sort ELIMINATED — updated_at is the trailing key, so the index
--           already supplies the ORDER BY updated_at ASC the queries ask for.
--   => 7.25x fewer buffers (4459 -> 615).
--
-- Live delta over a 3.09 min window (t0 2026-08-02T03:33:48Z): ~3.9 calls/min
-- combined, ~382 ms/min, ~17,355 blocks/min (~142 MB/min of buffer traffic).
-- Verified as a LIVE delta, not a lifetime pg_stat_statements total — plan
-- db-performance-remediation-2026-07-26 D-007 makes that distinction binding,
-- because 321 statements there carry huge lifetime cost while being idle now.
--
-- WHY ADDING AN INDEX IS OK ON A PLAN THAT HAS BEEN DROPPING THEM
-- P-002/P-003 of that plan removed dead indexes (330 unused). This one is
-- justified by measurement rather than by guess: two statements firing ~4x/min
-- use it. Column order is (workspace_id, harness_slug, status) = the equality
-- keys both queries bind, then updated_at to serve their ORDER BY. The partial
-- predicate matches the `archived = false` both queries also bind, and keeps the
-- index to the live subset.
--
-- NOT the end state: the real defect is storing `origin: scout` only inside the
-- markdown frontmatter, so a boolean test has to touch a TOASTed text column at
-- all. Deriving it into a real column (like items/decisions already are) would
-- remove the content read entirely. Tracked on WI-6839; this migration is the
-- zero-code-change step that stops the bleeding now.

CREATE INDEX IF NOT EXISTS harness_plans_ws_harness_status_updated_idx
  ON harness_shared.harness_plans (workspace_id, harness_slug, status, updated_at)
  WHERE archived = false;

COMMENT ON INDEX harness_shared.harness_plans_ws_harness_status_updated_idx IS
  'Serves the Scout draft/ready plan sweeps (draft-review-watchdog, ready-plan-autostart): equality on (workspace_id, harness_slug, status) + ORDER BY updated_at, partial on archived=false. Measured 4459 -> 615 buffers (WI-6839).';
