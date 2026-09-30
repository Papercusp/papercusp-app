-- 706-memory-recall-stats-query-shape.sql
--
-- context-injection-audit-2026-07-28 P-041 (I-F). The Phase 11 GATE: the
-- measurement instrument every other Phase 11 fix is measured THROUGH, exactly
-- as migration 703 (I-A) was for Phase 10.
--
-- THE GAP. `memory_recall_stats` records, in detail, what a recall RETURNED —
-- hit_count, top_score, the score list, the per-pool breakdown, the score
-- scale. It has never recorded one byte about what was ASKED. So every
-- question of the form "was this a good QUERY?" is currently unanswerable, and
-- the owner-raised defect this phase exists to fix (EI-18877983073219421 —
-- auto-injection retrieves on USER-side text only) has no measurable size.
--
-- WHY THE RESULT COLUMNS CANNOT SUBSTITUTE. They structurally cannot, and this
-- is the trap that hid the defect (D-015). The push path's `top_score` is RRF,
-- a RANK: something is ALWAYS rank 1, so the score is bit-for-bit identical
-- for a perfect query and for the literal word "continue". Measured live
-- 2026-07-28, `turn-start` sat at p50 0.03202 against the 2/61 = 0.032787
-- ceiling — 97.7% of maximum, which reads as flawless retrieval and says
-- nothing whatever about relevance. A query-quality metric therefore cannot be
-- derived from the result side at all; the query must be recorded directly.
--
--   query_chars   — length of the text ACTUALLY handed to the backend, envelope
--                   included, because that is what was embedded. Answers "what
--                   fraction of recalls are driven by a near-empty prompt".
--                   Saturation exactly at a clamp (turn-start clamps to 1000)
--                   is itself the signal that a long prompt was truncated.
--   query_sha256  — sha256 of the query with any ⟦turn-origin:… nonce:…⟧
--                   envelope STRIPPED and CRLF-normalized (turn-provenance's
--                   payloadSha256 over parseEnvelope().payload). Answers "was
--                   this query byte-identical to the last one in this session".
--   query_origin  — the origin CLAIMED by that envelope (loop-fire, wake-pump,
--                   self-compaction, fleet-kickoff, session-port, watchdog,
--                   coord-inject:*), NULL when absent. Answers "what fraction
--                   of recall traffic is machine boilerplate rather than a
--                   human question".
--   session_id    — which session the recall ran for. See below: without it the
--                   duplicate measurement is not merely imprecise, it is
--                   undefined.
--
-- ⚠ WHY THE HASH MUST STRIP THE ENVELOPE — THE SUBTLE PART. Machine-injected
-- turns arrive prefixed with `⟦turn-origin:<origin> nonce:<16 hex>⟧`, and the
-- nonce is freshly minted per turn. The turn-start hook posts the RAW prompt
-- (userpromptsubmit-memory.sh) and the route embeds `prompt.slice(0, 1000)`
-- verbatim, so that random nonce is part of the query. Hashing the raw text
-- would therefore make EVERY machine-injected query unique BY CONSTRUCTION —
-- the duplicate rate would read 0.0% no matter how identical the actual
-- prompts were, and 0% duplicates reads as perfectly healthy. That is the same
-- shape of failure as judging query quality by an RRF top_score: a metric
-- structurally incapable of detecting the condition it exists to detect.
-- Stripping the envelope before hashing is what makes this column mean
-- anything. The envelope is not discarded — it is recorded, as query_origin.
--
-- WHY session_id. "Byte-identical to the previous turn" is only defined WITHIN
-- a session; this table interleaves every concurrent agent on the box (12,313
-- recalls / 7d at the time of writing, ~30 live sessions). Lagging over the
-- whole table by created_at compares one agent's turn against a different
-- agent's, which measures nothing. The push path already carries the identity
-- (`session.sessionId`) and simply never recorded it; the pull path
-- (memory:search) has no session on its ctx and honestly records NULL.
--
-- WHY SHAPE AND NOT THE QUERY TEXT. Deliberate. The three questions above are
-- all answerable from shape, and shape carries no prompt content into a
-- telemetry table that is read by dashboards and retained indefinitely.
-- Revisit only with a concrete question shape cannot answer — and then with a
-- retention rule, not by widening this table by default.
--
-- WHY query_origin IS NOT A VERIFIED VERDICT. turn-provenance's full
-- `classify()` corroborates the envelope against an on-disk nonce ledger to
-- separate a genuine agent turn from an unverified/replayed claim. That is a
-- filesystem read, and this writer is fire-and-forget telemetry on the turn
-- hot path — so this column records the CLAIMED origin from the envelope only.
-- For measuring traffic mix that is exactly right (nothing here is adversarial
-- and nothing gates on it); it must never be cited as proof a turn was
-- agent-origin. The ledger-verified verdict stays with the provenance hook.
--
-- NO BACKFILL. The provenance was never captured, so historical rows stay NULL
-- and are excluded from every query-shape measurement. Any consumer must
-- window on created_at past the deploy, exactly as with 703 and 705.

ALTER TABLE harness_shared.memory_recall_stats
  ADD COLUMN IF NOT EXISTS query_chars  integer,
  ADD COLUMN IF NOT EXISTS query_sha256 text,
  ADD COLUMN IF NOT EXISTS query_origin text,
  ADD COLUMN IF NOT EXISTS session_id   text;

COMMENT ON COLUMN harness_shared.memory_recall_stats.query_chars IS
  'Chars of the query text actually handed to the backend (turn-origin envelope INCLUDED — it was embedded). NULL = pre-migration-706 row. context-injection-audit-2026-07-28 P-041.';
COMMENT ON COLUMN harness_shared.memory_recall_stats.query_sha256 IS
  'sha256 of the query with any turn-origin envelope STRIPPED and CRLF-normalized. Envelope-stripped because its per-turn random nonce would otherwise make every machine-injected query unique by construction and the duplicate rate read a false 0%. context-injection-audit-2026-07-28 P-041.';
COMMENT ON COLUMN harness_shared.memory_recall_stats.query_origin IS
  'Origin CLAIMED by the query text''s turn-origin envelope (loop-fire, wake-pump, self-compaction, ...); NULL when absent (owner-typed prompt, or a surface that builds its own query). CLAIMED, not ledger-verified — never cite as proof of agent origin. context-injection-audit-2026-07-28 P-041.';
COMMENT ON COLUMN harness_shared.memory_recall_stats.session_id IS
  'Session the recall ran for (push path: session.sessionId). NULL on the pull path, which has no session on its ctx. Required for per-session consecutive-duplicate detection — lagging across sessions measures nothing. context-injection-audit-2026-07-28 P-041.';

-- The read this exists to serve is a window function partitioned by session and
-- ordered by time (did this session ask the same thing twice in a row), over
-- the rows that HAVE a recorded query. Partial so the legacy NULL bulk — which
-- no query-shape reader will ever ask for — never enters the index.
CREATE INDEX IF NOT EXISTS memory_recall_stats_session_created_idx
  ON harness_shared.memory_recall_stats (session_id, created_at DESC)
  WHERE session_id IS NOT NULL;
