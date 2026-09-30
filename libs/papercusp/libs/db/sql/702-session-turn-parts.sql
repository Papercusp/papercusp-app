-- 702 — session_turn_parts: the FAITHFUL transcript companion to session_turns.
-- Plan: session-turn-storage-2026-07-28 (P-001, D-001/D-002).
--
-- WHY A SEPARATE TABLE AND NOT A part_kind COLUMN ON session_turns:
--   1. session_turns is the RECALL corpus and has ~12 live readers (sessions:
--      read/list/search/digest/timeline/_shared, search/sources.ts, embed-
--      backfill, adv/sessions, reconcile-loop-routines, streams.ts). A
--      discriminator column means every one of them must remember to filter,
--      and the first that forgets silently starts matching recall on tool
--      noise — the exact regression P-001 forbids. A separate table cannot be
--      forgotten.
--   2. Measured 2026-07-28: session_turns is 2211 MB total but only 472 MB
--      heap — 79% is the hnsw embedding index + the gin tsv index. Non-text
--      parts must never be embedded or tsv-indexed. This table therefore
--      carries a PK and a prune index and NOTHING else: growth is heap-only.
--
-- Retention is SHORTER than session_turns (14 d vs 45 d, enforced in
-- session-ingest.ts): recent sessions render faithfully from parts, older ones
-- degrade to the text turns in session_turns, older still to session_archives.
CREATE TABLE IF NOT EXISTS harness_shared.session_turn_parts (
  workspace_id text        NOT NULL DEFAULT 'default',
  source_kind  text        NOT NULL,
  session_id   text        NOT NULL,
  -- Monotonic within (workspace_id, source_kind, session_id), assigned in FILE
  -- order by the ingest cursor (session_ingest_state.part_count). This is the
  -- ONLY ordering the render path uses — ts is best-effort and can be null.
  part_idx     integer     NOT NULL,
  ts           timestamptz,
  owner        text,
  speaker      text        NOT NULL,
  -- text | thinking | tool_use | tool_result
  part_kind    text        NOT NULL,
  -- tool_use / tool_result only; null elsewhere.
  tool_name    text,
  text         text        NOT NULL,
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_turn_parts_pkey
    PRIMARY KEY (workspace_id, source_kind, session_id, part_idx)
);

-- The retention prune scans by age; without this it is a seq scan over the
-- bulkiest table in the corpus.
CREATE INDEX IF NOT EXISTS session_turn_parts_ingested_idx
  ON harness_shared.session_turn_parts USING btree (ingested_at);

-- Per-file part cursor, the exact analog of turn_count. Kept on the SAME
-- bookkeeping row so a single writeState advances both cursors atomically —
-- two rows could diverge on a partial failure and silently renumber parts.
ALTER TABLE harness_shared.session_ingest_state
  ADD COLUMN IF NOT EXISTS part_count integer NOT NULL DEFAULT 0;
