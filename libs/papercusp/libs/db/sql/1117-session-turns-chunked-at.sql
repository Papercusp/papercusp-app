-- Migration 1117 — chunk-sync state ON session_turns, so a caught-up
-- turn-chunk-sync tick reads no turn text at all.
--
-- THE RESIDUAL THIS RETIRES (EI-19456024312507672, filed by 753's author as the
-- half deliberately NOT bundled into that index).  turn-chunk-sync.ts detects
-- work with `NOT EXISTS (... c.turn_sha = sha256(turn text))`.  In the caught-up
-- steady state — where it lives almost all the time, returning zero work — it
-- still hashes every chunk-eligible turn's text on every 5-minute tick.
--
-- MEASURED on the live table, 2026-09-05, near-caught-up (20 stale rows):
--
--   shipped query (LATERAL sha)                   6859 ms
--   same query with no sha at all                 1338 ms
--   => pure hashing to discover nothing          ~5520 ms
--
-- 753 measured that residual at 528ms against 33,283 eligible turns / ~157MB.
-- It is now 203,492 eligible turns / ~1157MB, so the waste grew ~10.5x, exactly
-- as 753 predicted it would ("the cost scales with the volume of long-turn
-- text").  That growth is what makes this worth doing now.
--
-- Two things the original model did not capture, both measured here:
--   * The LATERAL "compute the sha once" trick does NOT hold at this scale.  The
--     planner inlines the subquery back into the anti-join's inner filter
--     (`Filter: (turn_sha = encode(sha256(convert_to(st.text,'UTF8')),'hex'))`,
--     Index Searches: 203494), hashing once per probe again.
--   * The sha costs more than CPU: it forces a SERIAL, heap-reading plan.
--     Without it the planner goes parallel (Gather Merge, 3 workers) and
--     Index Only (buffers 1.88M -> 839k).  Reaching the heap for `text` is what
--     forfeits both.
--
-- THE FIX.  `chunked_at` on the parent row plus a partial index over exactly
-- the not-yet-chunked eligible turns.  A caught-up tick then matches ZERO index
-- entries and touches no text.  No index or query rewrite can achieve this:
-- the cost IS hashing 1.15GB, so only not-hashing removes it.
--
-- WHY THE BACKFILL NEEDS NO HASHING — the load-bearing invariant.
-- `session_turns.text` is INSERT-ONLY.  The sole production writer
-- (packages/operator-core/lib/search/session-ingest.ts) inserts
-- `ON CONFLICT DO NOTHING`, and the only two UPDATEs against this table set
-- `owner` and `turn_origin*` respectively — neither touches `text`.  So a turn
-- that has ANY chunk row has CURRENT chunks by construction, and marking it
-- chunked without recomputing its sha is sound.
--
-- That invariant is not merely argued, it is measured: across all 203,474
-- eligible turns that have chunks, the number whose stored turn_sha disagrees
-- with sha256(current text) is ZERO (re-verified 2026-09-05T01:00Z).  A few
-- dozen eligible turns have no chunks at all (47 at that reading, and the exact
-- figure moves with ingest) — those are the genuine backlog, and step 3 below
-- re-opens whatever set of them exists at apply time rather than a fixed count.
--
-- turn-chunk-sync.ts asserts the invariant it depends on
-- (`session-turns-text-immutable.test.ts`), so a future writer that starts
-- UPDATEing `text` fails a test instead of silently stranding turns unchunked.
--
-- WHY `ADD COLUMN ... DEFAULT <constant>` RATHER THAN A BACKFILL UPDATE.
-- Marking 203k rows chunked with an UPDATE would rewrite every one of them
-- inside the runner's transaction, on the hottest shared table, at boot.  A
-- NON-VOLATILE column default is instead stored once as a catalog missing-value
-- (PG11+), so this is metadata-only and instant regardless of table size; the
-- default is then dropped so NEW turns arrive NULL and are picked up as work.
-- Only the small genuine backlog is touched by a real UPDATE.
--
-- EXPAND-ONLY, so no FORWARD-COMPAT acknowledgment is required: this adds a
-- nullable column and a non-unique index.  The currently-deployed release keeps
-- running its sha-based query, which is unaffected by an extra column it never
-- names (session-ingest's INSERT uses an explicit column list).
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; files >=215),
-- and CREATE INDEX CONCURRENTLY is therefore not legal here.  The partial index
-- is built over ~26 matching rows, so the ShareLock it takes on session_turns
-- is momentary — unlike the full-table build 753 paid ~1s for.

-- 1. Instant, metadata-only: every row that exists NOW is treated as chunked.
--    A constant literal (not now()) keeps the default non-volatile and so keeps
--    the fast path; the exact value is immaterial, it only has to be non-NULL.
ALTER TABLE harness_shared.session_turns
  ADD COLUMN IF NOT EXISTS chunked_at timestamptz DEFAULT '2026-09-05 00:00:00+00';

-- 2. New turns must arrive NULL, i.e. as work for the sync to pick up.
ALTER TABLE harness_shared.session_turns
  ALTER COLUMN chunked_at DROP DEFAULT;

-- 3. Re-open the genuine backlog that step 1 marked chunked along with
--    everything else: eligible turns that have no chunk rows at all.
UPDATE harness_shared.session_turns st
   SET chunked_at = NULL
 WHERE length(st.text) > 2000
   AND st.chunked_at IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM harness_shared.session_turn_chunks c
          WHERE c.workspace_id = st.workspace_id
            AND c.source_kind  = st.source_kind
            AND c.session_id   = st.session_id
            AND c.turn_idx     = st.turn_idx
       );

-- 4. The detection index. Mirrors session_turns_chunkable_idx's ordering
--    (ingested_at DESC, freshest-first) but excludes already-chunked turns
--    outright, which is the whole point: caught up => zero entries to scan.
CREATE INDEX IF NOT EXISTS session_turns_unchunked_idx
  ON harness_shared.session_turns (ingested_at DESC)
  WHERE length(text) > 2000 AND chunked_at IS NULL;
