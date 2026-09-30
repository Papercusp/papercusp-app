-- 609-session-cursor.sql — ambient-semantic-push-2026-07-14 P-001 (live leg).
--
-- session_cursor — the CURRENT lexical cursor per native session: a recency-
-- decayed sparse term-weight vector mined from the session's own journal notes
-- (session_turn_journal, migration 605). Rebuilt at turn end by the P-001 live
-- leg (buildAndPersistCursor, wired fail-soft + DEFAULT-OFF behind
-- PAPERCUSP_AMBIENT_CURSOR into journal:record-turn) and UPSERTED here keyed by
-- session_id — one row = one session's latest cursor, not a per-turn log (the
-- cursor already decays across recent notes, so the latest cursor IS the state).
--
-- `terms` is the sparse vector as authored by lexical-cursor.buildCursor:
-- a JSON array of { term, termClass, weight }, descending by weight, capped
-- (DEFAULT_CURSOR_MAX_TERMS). It reconstructs to a full LexicalCursor via
-- session-cursor-store.rowToCursor (the weightByTerm / classByTerm maps are
-- derived from it). ECHO-GUARD (ambient D-001): the cursor is built from the
-- agent's OWN 'agent'-source journal notes only — never mechanical/flagged rows,
-- never pushed content; enforced upstream by selectCursorNotes, not here.
--
-- Consumers (later phases, all DEFAULT-OFF): P-002 exposes a session's cursor to
-- peers/leader via coord presence; P-004 reads the recently-updated cursors and
-- builds the in-memory inverted index for peer-collision detection.
--
-- Conventions mirror session_turn_journal (605): workspace_id defaults 'default'
-- (transcript-driven writes carry no workspace identity), no RLS, bounded
-- indexes — the journal remains the archive, stale cursors are pruned code-side.
--
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level BEGIN/COMMIT —
-- the migration runner wraps each file in its own transaction.

CREATE TABLE IF NOT EXISTS harness_shared.session_cursor (
  session_id   TEXT        PRIMARY KEY,          -- native client session id (one current cursor per session)
  workspace_id TEXT        NOT NULL DEFAULT 'default',
  owner_id     TEXT,                             -- coord identity (PAPERCUSP_SID) when known
  harness_slug TEXT,
  turn_ts      TIMESTAMPTZ,                       -- the turn whose journal note produced this cursor
  note_count   INTEGER     NOT NULL DEFAULT 0,    -- notes that fed the cursor (post echo-guard)
  term_count   INTEGER     NOT NULL DEFAULT 0,    -- sparse-vector size (jsonb_array_length(terms))
  terms        JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- [{ term, termClass, weight }], descending weight
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- P-004 reads the freshest cursors across live sessions (recently-updated
-- first) to build the inverted index; the prune scans the same axis by age.
CREATE INDEX IF NOT EXISTS session_cursor_updated_idx
  ON harness_shared.session_cursor (updated_at DESC);

-- P-002 exposes a cursor per owner (a session's owner) to peers/leader.
CREATE INDEX IF NOT EXISTS session_cursor_owner_idx
  ON harness_shared.session_cursor (owner_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.session_cursor TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.session_cursor TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;
