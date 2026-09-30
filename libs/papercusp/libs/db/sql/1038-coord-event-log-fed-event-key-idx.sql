-- Migration 1038 — index the git-sync fed-event readers on coord_event_log
-- (EI-21893070865750886).
--
-- WHY. Three git-sync readers filter coord_event_log on `body->'fed_event'->>'key'`,
-- and nothing indexed that expression, so each degraded to a full parallel seq scan of
-- a 409,908-row / 371 MB table on every tick. The `Sort` sits BELOW the `Limit`, so
-- `LIMIT` cannot short-circuit either: every execution is O(table).
--
-- The zero-row path is the WORST case and it is the COMMON case. Two of these sites end
-- `if (feRows.length === 0) return; // fast no-op`. That comment is backwards — zero
-- matching rows is precisely the case where the scan runs to completion having found
-- nothing. Fed-events are rare relative to total surface='messages' traffic, so the
-- expensive path runs on git-sync's cadence, forever.
--
-- THE THREE CALL SITES (all in harness/git-sync/git-sync-action.ts). The column order
-- below is chosen to serve all three; each was measured, not assumed:
--   A  ~:4298  key = REF_ANNOUNCE      + id > watermark   ORDER BY id ASC   LIMIT 200
--   B  ~:5095  key = STAGING_ADVANCE   + id > watermark   ORDER BY id ASC   LIMIT 200
--              AND body->'fed_event'->>'repo_key' = $
--   C  ~:3513  key = REF_ANNOUNCE      (no id predicate)  ORDER BY id DESC  LIMIT 500
--
-- MEASURED on an isolated replica of the live tenant (82,599 rows, 9,642 carrying a
-- fed_event key, post-ANALYZE; `body` trimmed to just fed_event, which makes the seq
-- scan CHEAPER than production and so biases the planner AWAY from the index — a
-- conservative bias). Buffers, since wall-clock on a warm cache understates the win:
--
--   site A, no-match   seq scan 1,408 buf / 25.878 ms  ->  3 buf / 0.119 ms
--   site B, no-match   seq scan 1,408 buf / 25.878 ms  -> 40 buf / 4.569 ms
--   site C, 500 rows   seq scan 1,408 buf              -> 431 buf / 0.874 ms  (Index Scan Backward)
--
-- ⚠ TWO SHAPES THAT LOOK RIGHT AND ARE NOT. Both were built and measured before this
-- one was chosen; do not "simplify" the index back into either.
--
--   (1) LEADING COLUMNS ONLY — (workspace_id, harness_slug, id), key left out. This is
--       the shape the original filing proposed, reasoning from the planner's `rows=90`
--       estimate. That estimate is the count of rows matching ALL predicates INCLUDING
--       `key = $4`; it is NOT the index's population. The real population is 9,641 rows
--       across 2,983 distinct keys (~3.2 rows per key), so a lookup walks all 9,642
--       entries in id order, heap-fetching each to recheck the key, and never fills
--       LIMIT 200. Measured on site A's no-match path: 7,786 buffers — 5.5x MORE I/O
--       than having no index at all, while still appearing ~4 ms faster on the clock.
--       It would have shipped as a regression that looked like an optimization.
--
--   (2) repo_key placed BEFORE id. It must come AFTER id. Sites A and C depend on `id`
--       sitting immediately after the equality prefix (workspace_id, harness_slug, key)
--       so the btree already yields rows in id order and the LIMIT short-circuits with
--       no Sort node. Moving repo_key ahead of id breaks that adjacency for the two
--       sites that never filter on repo_key. As a TRAILING column it is free to them and
--       lets site B discard non-matching rows in-index: 1,992 -> 40 buffers (~50x), for
--       +128 kB of index. Site A and C plans are unchanged by its presence (verified).
--
-- PARTIAL-INDEX ALIGNMENT (scripts/check-partial-index-alignment.mjs). A partial index
-- is usable only if the planner can PROVE the query's predicates imply the index's WHERE
-- clause. Both halves hold, and neither is accidental:
--   * `surface = 'messages'` — stated verbatim by all three queries.
--   * `(body->'fed_event'->>'key') IS NOT NULL` — implied by `... = $`, because `=` is
--     strict, so a NULL input cannot satisfy it. This is why the predicate is IS NOT NULL
--     and NOT a `body ? 'fed_event'` presence test: PostgreSQL's implication prover
--     CANNOT derive `col ? 'k'` from `col ->> 'k' = $1` (different operators over
--     different expressions), which is the exact trap that guard exists to catch and that
--     has bitten this repo three times. The clause reads as redundant noise and is
--     load-bearing for the PLAN, not for the RESULT. Do not remove it.
--
-- NOT CONCURRENTLY, deliberately. The migration runner wraps each file in its own
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one (same tradeoff as
-- migrations 753 / 792 and every other index in this tree). The build therefore takes a
-- ShareLock, blocking INSERTs to coord_event_log for its duration. MEASURED against the
-- LIVE table by running this exact statement inside a rolled-back transaction:
-- 0.680 s, producing a 1,504 kB index. Sub-second on a hot table needs no maintenance
-- window; the index stays small because the partial predicate admits only the ~9.6k
-- fed_event rows out of 409,908.
--
-- FORWARD-COMPAT / DEPLOY ORDER: safe in both directions. Purely ADDITIVE — creates one
-- new index and drops, renames and narrows nothing, so there is no destructive DDL for
-- the currently-deployed release to trip over.
--   DB ahead of code (the normal order): the running :3070 release issues these same
--     queries and simply starts being served by the index. No code change is needed to
--     benefit, and none is needed to keep working.
--   Code ahead of DB: impossible to break — nothing in the tree references this index by
--     name; without it the queries fall back to the seq scan they already do today.
--
-- ⚠ Do NOT verify by EXPLAINing inside the transaction that builds the index: a freshly
-- built index in an uncommitted transaction has no statistics, so the planner falls back
-- to a seq scan and it reads as "the index does not work". That is an artifact of the
-- probe. Verify on the committed index, or on an ANALYZEd replica as done above.
--
-- The migration runner wraps each file in its own transaction, so this file carries NO
-- top-level BEGIN;/COMMIT; (migration-runner contract; files >=215).

CREATE INDEX IF NOT EXISTS coord_event_log_fed_event_key_idx
  ON harness_shared.coord_event_log
  USING btree (
    workspace_id,
    harness_slug,
    ((body -> 'fed_event'::text) ->> 'key'::text),
    id,
    ((body -> 'fed_event'::text) ->> 'repo_key'::text)
  )
  WHERE surface = 'messages' AND ((body -> 'fed_event'::text) ->> 'key'::text) IS NOT NULL;
