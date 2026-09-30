-- Migration 1242 — the SHARED chunk store for long prose rows
-- (generic-rag-chunking-2026-09-29 P-003, decisions D-002/D-010).
--
-- WHY THIS TABLE EXISTS. Every prose embedding column is built from
-- left(text, 2000), so a query about anything past the cut cannot find its
-- row. Migration 749 fixed that for session turns only, with a table shaped
-- around the session_turns key. The P-001 bench measured the same loss on
-- plans (tail MRR 0.64), work items (0.75), consult questions (0.40) and
-- operator turns (0.36), and chunking lifted each of them. One table per
-- collection would repeat 749 four times over; this is one store that any
-- collection writes into, keyed by a surface name and the parent's own key.
--
-- WHAT A ROW IS. One chunk of one parent row:
--   surface          which registered collection the parent belongs to
--                    (e.g. 'plans', 'work_items'). Registering a collection
--                    is a registry entry in code, never DDL (acceptance R-9).
--   parent_key       the parent's primary key as text, in the parent's column
--                    order. An array because key shapes differ by collection:
--                    one column for some, (workspace_id, id) for others.
--   chunk_idx        0-based position within the parent.
--   anchor, header   where the chunk sits (a markdown heading anchor) and the
--                    context line embedded with it; NULL for window chunks.
--   parent_sha       sha256 of the parent text the chunks were cut from. A
--                    parent whose current sha differs is re-split.
--   chunk_sha        sha256 of this chunk's embedded text. A re-split copies
--                    the embedding from an old chunk with the same chunk_sha,
--                    so an edit re-embeds only the chunks that changed.
--   splitter_version bumped by the library when splitter output changes, so
--                    stale chunks are re-cut rather than trusted.
--
-- NO FOREIGN KEY, on purpose: parents live in different tables with different
-- key shapes, so no single FK can express them. Orphans are removed by the
-- sync engine's prune (P-004), and every query joins back to the parent, so a
-- chunk of a deleted row is never returned even before the prune reaches it.
--
-- The embedding columns follow the shared prose contract: vector(768)
-- (PROSE_VECTOR_DIMS, migration 727), an embedding_mode discriminator and an
-- embedding_profile identity (migration 1154). The column is registered in
-- PROSE_VECTOR_COLUMNS so a future width migration includes it.

CREATE TABLE IF NOT EXISTS harness_shared.text_chunks (
  surface           text        NOT NULL,
  parent_key        text[]      NOT NULL,
  chunk_idx         integer     NOT NULL,
  anchor            text,
  header            text,
  content           text        NOT NULL,
  parent_sha        text        NOT NULL,
  chunk_sha         text        NOT NULL,
  splitter_version  text        NOT NULL,
  embedding         vector(768),
  embedding_mode    text,
  embedding_profile text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (surface, parent_key, chunk_idx),
  CONSTRAINT text_chunks_surface_nonempty CHECK (surface <> ''),
  CONSTRAINT text_chunks_parent_key_nonempty CHECK (cardinality(parent_key) > 0),
  CONSTRAINT text_chunks_chunk_idx_nonnegative CHECK (chunk_idx >= 0)
);

COMMENT ON TABLE harness_shared.text_chunks IS
  'Shared chunk store for prose rows longer than the 2000-char embedding window '
  '(generic-rag-chunking-2026-09-29). One row per chunk of one parent, keyed by '
  '(surface, parent_key, chunk_idx). No FK: the sync engine prunes orphans and '
  'every reader joins back to the parent.';
COMMENT ON COLUMN harness_shared.text_chunks.parent_key IS
  'The parent row''s primary key as text, in the parent''s key column order.';
COMMENT ON COLUMN harness_shared.text_chunks.embedding IS
  'Prose-contract embedding (768-dim) of header + content. NULL until the '
  'embed-backfill sweep reaches the chunk, or copied from an old chunk with the '
  'same chunk_sha when its parent is re-split.';
COMMENT ON COLUMN harness_shared.text_chunks.embedding_mode IS
  'Which embedder produced embedding — NULL means unembedded, not "embedded by '
  'an unknown mode".';

CREATE INDEX IF NOT EXISTS text_chunks_updated_idx
  ON harness_shared.text_chunks (updated_at);
CREATE INDEX IF NOT EXISTS text_chunks_embedding_mode_idx
  ON harness_shared.text_chunks (embedding_mode)
  WHERE embedding_mode IS NOT NULL;
CREATE INDEX IF NOT EXISTS text_chunks_embedding_hnsw_idx
  ON harness_shared.text_chunks USING hnsw (embedding vector_cosine_ops);
