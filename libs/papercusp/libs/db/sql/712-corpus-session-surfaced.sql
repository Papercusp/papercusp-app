-- 712-corpus-session-surfaced.sql
--
-- context-injection-audit-2026-07-28 P-008 / D-037. The per-session-epoch
-- dedup ledger for the SECOND retrieval leg (corpus-recall).
--
-- Why a new table rather than reusing `memory_session_surfaced` (D-006/P-002,
-- migration 517): that ledger's key column is `memory_id uuid`, and its
-- readers filter candidates through a UUID_SHAPE guard before touching PG.
-- The corpus leg's handles are NOT uuids — they are `WI-6512` / `EI-19301…`
-- work-item ids and `<source_kind>:<session_id>` session refs. Coercing them
-- into a uuid column (hashing to a synthetic uuid) would make the ledger's own
-- type a lie and destroy the ability to read back WHAT was surfaced, which is
-- the only reason the ledger is queryable at all. Two corpora with genuinely
-- different key shapes get two tables.
--
-- Semantics mirror memory_session_surfaced exactly, so the two dedups behave
-- identically from the agent's point of view:
--
--   * keyed on (session_id, epoch, ref) — the epoch is the COMPACTION
--     generation, so a post-compaction epoch bump re-primes every pointer
--     (the injected line left the context window with the compaction; it is
--     new information again). Mid-epoch it stays suppressed, because a warm
--     session still carries the line it was given.
--   * `port` records WHICH injection moment delivered it (turn-start / claim /
--     create / brief / …), so "did this port ever deliver anything" stays
--     answerable per port rather than only in aggregate.
--
-- Without this table the corpus leg re-injects the SAME three pointers on
-- every turn-start until the query text changes — precisely the turn-over-turn
-- waste D-006 exists to prevent, and the reason that plan's watermark was
-- built in the first place.

CREATE TABLE IF NOT EXISTS harness_shared.corpus_session_surfaced (
  session_id   text        NOT NULL,
  epoch        integer     NOT NULL DEFAULT 0,
  ref          text        NOT NULL,
  port         text,
  surfaced_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, epoch, ref)
);

-- The read is always "which of THESE refs has this (session, epoch) already
-- seen" — covered by the primary key. This index serves the retention sweep
-- and the per-port utilization read instead.
CREATE INDEX IF NOT EXISTS corpus_session_surfaced_at_idx
  ON harness_shared.corpus_session_surfaced (surfaced_at);

COMMENT ON TABLE harness_shared.corpus_session_surfaced IS
  'P-008/D-037: per-session-epoch dedup ledger for corpus-recall pointer handles (work-item ids and <kind>:<session_id> session refs). The uuid-keyed sibling for mem0 memories is memory_session_surfaced.';
