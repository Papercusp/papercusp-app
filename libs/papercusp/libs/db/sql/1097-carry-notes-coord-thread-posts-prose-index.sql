-- 1097-carry-notes-coord-thread-posts-prose-index.sql
--
-- WI-2142144: carry_notes and coord_thread_posts have NEITHER an embedding
-- NOR a tsvector — the two corpora the whole continuity design reads from
-- (work-item checkpoints / loop carry-notes, and coord thread discussion)
-- were the only prose surfaces in harness_shared with no index at all, so
-- prior-attempt-context.ts greps them with keyword regexes for lack of any
-- alternative.
--
-- This is PURELY infrastructure (D-005/D-010 pattern already used by
-- harness_docs/harness_plans/session_turns): it makes both tables
-- semantically (embedding) AND lexically (GENERATED tsvector) searchable.
-- It does NOT change what is EXTRACTED from a note/post's prose (that is a
-- separate, harder LLM-pass problem — see the work-item body) and it does
-- NOT wire either table into a query-time consumer; embed-backfill.ts's
-- TARGETS entry (added alongside this migration) is what actually fills
-- the new columns, on its normal governed cadence.
--
-- PURELY ADDITIVE — no DROP, no RENAME, no SET NOT NULL on an existing
-- column, so no FORWARD-COMPAT acknowledgment is required (:3070 keeps
-- serving fine with these columns simply unpopulated until the sweep
-- reaches them).
--
-- No top-level BEGIN/COMMIT — the migration runner wraps each file in its
-- own transaction (lint:migrations). Idempotent: IF NOT EXISTS everywhere.

-- ---------------------------------------------------------------------------
-- 1. carry_notes — work-item checkpoints / armed-loop carry-notes
-- ---------------------------------------------------------------------------

ALTER TABLE harness_shared.carry_notes
  -- vector(768) to match harness_plans / doc_sections / work_items / harness_docs —
  -- the shared prose contract (prose-vector-dims.ts PROSE_VECTOR_DIMS). Filled by
  -- the embed-backfill sweep (bench lane, admission-governed), NEVER at
  -- checkpoint-write time — a checkpoint write must never block on a network
  -- embed call (same contract as session_turns).
  ADD COLUMN IF NOT EXISTS note_embedding      vector(768),
  ADD COLUMN IF NOT EXISTS note_embedding_mode text,
  -- GENERATED column (no trigger to forget, no write-path change needed) —
  -- mirrors session_turns.text_tsv / personal_documents.text_tsv.
  ADD COLUMN IF NOT EXISTS note_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(note, ''))) STORED;

COMMENT ON COLUMN harness_shared.carry_notes.note_embedding IS
  'Prose-contract embedding (768-dim, gemma/openai) of note, left()-capped at 2000 '
  'chars by the embed-backfill TARGETS entry. NULL until the sweep reaches this row.';
COMMENT ON COLUMN harness_shared.carry_notes.note_embedding_mode IS
  'Which embedder produced note_embedding (migration-530-style discriminator) — '
  'NULL means unembedded, not "embedded by an unknown mode".';

CREATE INDEX IF NOT EXISTS carry_notes_tsv_idx
  ON harness_shared.carry_notes USING gin (note_tsv);

CREATE INDEX IF NOT EXISTS carry_notes_embedding_hnsw_idx
  ON harness_shared.carry_notes USING hnsw (note_embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS carry_notes_embedding_mode_idx
  ON harness_shared.carry_notes USING btree (note_embedding_mode)
  WHERE note_embedding_mode IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. coord_thread_posts — comment-thread discussion posts
-- ---------------------------------------------------------------------------

ALTER TABLE harness_shared.coord_thread_posts
  ADD COLUMN IF NOT EXISTS body_embedding      vector(768),
  ADD COLUMN IF NOT EXISTS body_embedding_mode text,
  ADD COLUMN IF NOT EXISTS body_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED;

COMMENT ON COLUMN harness_shared.coord_thread_posts.body_embedding IS
  'Prose-contract embedding (768-dim, gemma/openai) of body, left()-capped at 2000 '
  'chars by the embed-backfill TARGETS entry. NULL until the sweep reaches this row.';
COMMENT ON COLUMN harness_shared.coord_thread_posts.body_embedding_mode IS
  'Which embedder produced body_embedding (migration-530-style discriminator) — '
  'NULL means unembedded, not "embedded by an unknown mode".';

CREATE INDEX IF NOT EXISTS coord_thread_posts_tsv_idx
  ON harness_shared.coord_thread_posts USING gin (body_tsv);

CREATE INDEX IF NOT EXISTS coord_thread_posts_embedding_hnsw_idx
  ON harness_shared.coord_thread_posts USING hnsw (body_embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS coord_thread_posts_embedding_mode_idx
  ON harness_shared.coord_thread_posts USING btree (body_embedding_mode)
  WHERE body_embedding_mode IS NOT NULL;
