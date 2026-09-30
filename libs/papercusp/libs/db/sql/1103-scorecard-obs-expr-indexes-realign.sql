-- 1103-scorecard-obs-expr-indexes-realign.sql
--
-- WI-2143953 — migration 1096 silently orphaned BOTH scorecard expression indexes,
-- and the acceptance-gate resolver has been timing out (pg 57014) ever since, so no
-- plan in the workspace can reach status:'shipped'.
--
-- THE CAUSAL CHAIN, IN THREE MIGRATIONS
--   842 added two PARTIAL expression indexes for the scorecard/observation jsonb
--       paths. It indexed `((payload - '_ei') -> 'observation') ->> '<key>'`, and its
--       header says exactly why: "listScorecards reads through the engineer_issues
--       VIEW, whose payload column is `payload - '_ei'`. After view inlining the
--       planner therefore sees expressions of the exact shape [...] and an index is
--       only usable if its expression matches that shape structurally (a plain
--       payload -> 'observation' index would never match)."
--   1096 changed that view column from `payload - '_ei' AS payload` to plain
--       `payload`. That change is CORRECT and stays: it removed a real
--       silent-wrong-answer footgun where `payload->'_ei'->>'severity'` resolved to
--       NULL for every one of 155,160 issue-family rows, so a count of criticals
--       returned a confident 0 when there were 27.
--   1103 (this file) re-points the indexes at the post-1096 shape. 842's REASONING was
--       right and is quoted above; only its accessor is stale. Nothing here reverts
--       1096, and nothing here changes a query result — an index cannot.
--
-- The failure is silent by construction: an expression index that no query can produce
-- is not an error, a warning, or a plan regression anyone is looking at. It is simply
-- never chosen. The index still exists, still appears in the schema reference and the
-- index manifest, and still costs write maintenance on every INSERT — so the next
-- reader who checks "is this path indexed?" gets YES and moves on. That is the trap
-- this migration removes, not merely the latency.
--
-- MEASURED ON THE LIVE TABLE (2026-09-04, harness_shared.work_items = 173,637 rows /
-- 4.5 GB total / 2.0 GB heap; 2,758 rows carry an observation rubricRef).
--
--   The gate's own query — listScorecards' primary SELECT with its correlated
--   `superseded_by` subquery, at the gate's LIMIT 50 — via the view, EXPLAIN ANALYZE:
--     before  ~25 s (extrapolated at 0.5 s/row from a measured 5-row run at 2,788 ms;
--             the full run does not complete inside statement_timeout)
--     after   6.352 ms
--   The outer scan alone: 373 ms / 433,570 shared-buffer hits, a parallel bitmap heap
--   scan examining 177,813 rows to return 269. The same predicate written to match the
--   842 index expression: 0.102 ms / 53 buffers via work_items_obs_rubric_ref_idx —
--   which is the direct proof that the indexes work and simply cannot be reached.
--
--   The correlated subquery is what converts that gap into a timeout: it re-runs the
--   full scan ONCE PER OUTPUT ROW. After this migration it is a BitmapAnd over both
--   new indexes at 0.008 ms per loop.
--
-- WHY NOT workspace_id-LEADING, though every call site is workspace-scoped and
-- migration 1053 advises leading with it. MEASURED, because that advice does not
-- generalise to this shape: a composite (workspace_id, <expr>) pair is 163 ms versus
-- 6.352 ms for the expression-only pair — 25x WORSE. With the composite the planner
-- stops combining the two indexes and drives the subquery from the rubricRef index
-- alone, re-examining all 269 rubric rows on each of the 51 loops. The expression-only
-- form lets it BitmapAnd rubricRef with supersedes, which is the whole win. 842's
-- original shape was right; keep it.
--
-- PARTIAL (IS NOT NULL) ON PURPOSE, and the predicate is load-bearing: 2,758 of
-- 173,637 rows carry a rubricRef and far fewer carry a supersedes, so the partial
-- predicate keeps both indexes tiny (64 kB and 16 kB measured). Every consuming query
-- constrains these paths with `=`, which implies IS NOT NULL, so the partial indexes
-- stay eligible. Do not "simplify" either predicate and do not add columns to either
-- index without re-measuring the correlated subquery — see the paragraph above for
-- what happens when you do.
--
-- NOT CONCURRENTLY, deliberately. The migration runner wraps each file in its own
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one (same tradeoff as
-- migrations 753 / 792 / 1038 / 1053). The build takes a ShareLock, blocking INSERTs to
-- work_items for its duration. MEASURED by running these exact statements inside a
-- rolled-back transaction against the live table: 658.717 ms for BOTH indexes
-- combined, producing 64 kB + 16 kB. Sub-second on a hot table needs no maintenance
-- window, matching the precedent set by 1038 (0.680 s) and 1053 (~1.6 s).
--
-- FORWARD-COMPAT: the two DROPs below are safe against the currently-deployed release
-- because the indexes they remove are UNREACHABLE BY CONSTRUCTION, not merely unused.
-- Since 1096 the engineer_issues view exposes plain `payload`, so no query through the
-- view can produce the `(payload - '_ei') -> 'observation'` expression these indexes
-- are built on, in any release old or new. The only remaining way to reach them would
-- be a query written directly against the base table in that deliberate shape; a tree
-- search for `payload - '_ei'` finds only prose comments, a test schema fixture, and
-- the issues-engineer WRITE trigger that composes the column — no read path. Dropping
-- an index also cannot change a result, so the worst case of being wrong here is that
-- some unfound query gets slower, never that it breaks. The CREATEs are additive and
-- land first, so the fast path exists before the old indexes go.

CREATE INDEX IF NOT EXISTS work_items_obs_rubric_ref_v2_idx
  ON harness_shared.work_items ((((payload -> 'observation') ->> 'rubricRef')))
  WHERE (((payload -> 'observation') ->> 'rubricRef') IS NOT NULL);

COMMENT ON INDEX harness_shared.work_items_obs_rubric_ref_v2_idx IS
  'WI-2143953: access path for listScorecards'' primary SELECT (packages/operator-core/'
  'lib/scorecards.ts) and every rubricRef-filtered read through the engineer_issues '
  'view. Replaces work_items_obs_rubric_ref_idx from migration 842, whose '
  '(payload - ''_ei'') accessor became unreachable when migration 1096 stopped the view '
  'subtracting _ei. THE EXPRESSION MUST KEEP MATCHING THE VIEW: if the view''s payload '
  'column ever changes shape again, this index silently stops being usable and the '
  'acceptance gate times out (pg 57014) with nothing failing loudly. Measured '
  '2026-09-04: the gate query went 25 s -> 6.352 ms.';

CREATE INDEX IF NOT EXISTS work_items_obs_supersedes_v2_idx
  ON harness_shared.work_items ((((payload -> 'observation') ->> 'supersedes')))
  WHERE (((payload -> 'observation') ->> 'supersedes') IS NOT NULL);

COMMENT ON INDEX harness_shared.work_items_obs_supersedes_v2_idx IS
  'WI-2143953: access path for listScorecards'' correlated `superseded_by` subquery, '
  'which runs ONCE PER OUTPUT ROW and is what turned the missing access path into a '
  'statement timeout rather than merely a slow read. Must be BitmapAnd-able with '
  'work_items_obs_rubric_ref_v2_idx — adding columns to either index breaks that '
  'combination and costs 25x (measured; see migration 1103''s header). Replaces '
  'work_items_obs_supersedes_idx from migration 842.';

-- Contract: remove the two indexes that 1096 made unreachable. They cannot serve any
-- read (see FORWARD-COMPAT above), but they are still maintained on every write to a
-- 173,637-row hot table, and they still read as "this path is indexed" to the next
-- person who looks — which is exactly how this went unnoticed.
DROP INDEX IF EXISTS harness_shared.work_items_obs_rubric_ref_idx;
DROP INDEX IF EXISTS harness_shared.work_items_obs_supersedes_idx;
