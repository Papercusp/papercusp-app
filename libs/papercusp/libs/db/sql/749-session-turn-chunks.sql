-- Migration 749 — per-chunk embedding store for LONG session turns (P-034,
-- semantic-search-fingerprint-coverage-2026-08-03, decision D-016).
--
-- WHY THIS TABLE EXISTS. `session_turns.text_embedding` is built from
-- `left(text, 2000)`, so everything past 2000 chars is unretrievable by the
-- semantic leg. Measured 2026-08-03 over 33,171 truncated turns (8.14% of the
-- table) holding 90,569,619 invisible characters: a probe drawn from past the
-- cut ranks its true parent turn at MRR ~0.25 / recall@1 ~14% out of 60
-- candidates. Chunking the same corpus with the same queries lifts that to MRR
-- 0.73-0.84 / recall@1 60-75% — a +216% to +230% improvement.
--
-- ⚠ WIDENING THE CUT IS NOT THE ALTERNATIVE, AND THIS IS THE PART THAT LOOKS
-- WRONG UNTIL YOU MEASURE IT. "Just raise left(text,2000) to 8000 — the sidecar
-- accepts 32k, every turn is capped at 8k, and it needs no new table" is true in
-- every clause and still the wrong conclusion. More text in ONE 768-dim vector
-- DILUTES it, so the width sweep PEAKS and then DECLINES: at a probe offset of
-- 3000, width 8000 (MRR 0.5370) is materially WORSE than width 4000 (0.6195).
-- Worse, no width has a stable optimum — the apparent winner is just the
-- narrowest width containing the probe. Moving the probe from 3000 to 5500
-- collapsed width 4000 by 49% (0.6195 -> 0.3189) and moved the peak to 6000.
-- Chunking was the only position-INDEPENDENT arm, winning at BOTH offsets. At
-- 8000 chars a single vector captures only ~49% of what chunking delivers.
-- Do not re-litigate this; D-016 carries the full table.
--
-- SHAPE. One row per (parent turn, chunk_idx), mirroring migration 552's
-- doc_sections precedent exactly: derived text synced by
-- operator-core/lib/search/turn-chunk-sync.ts (sha-keyed change detection,
-- embedding left NULL) and vectorized by the 5-min embed-backfill sweep's
-- TARGETS entry under the 530/551 space discipline (embedding_mode written with
-- the vector; the query side filters to the active space; the sweep re-embeds
-- rows whose mode IS DISTINCT FROM the active one).
--
-- The chunker is deliberately a derived CACHE of session_turns.text, not a
-- second source of truth: `content` is a slice of the parent's `text`, and
-- `turn_sha` is sha256 of that text so an edited/re-ingested turn replaces its
-- chunks wholesale. Only turns LONGER than the 2000-char cut are chunked at all
-- — a turn at or below it is already fully covered by its own parent vector,
-- and chunking it would add rows and vector cost for exactly zero recall.
--
-- KEYED ON THE PARENT PK + chunk_idx, with an ON DELETE CASCADE FK. session
-- re-ingest/dedup genuinely deletes turns, and an orphaned chunk is worse than a
-- missing one: it stays in the HNSW index and keeps scoring against a turn that
-- no longer exists, so the search leg's join drops the hit and the vector is
-- pure cost forever. The FK makes that unrepresentable rather than relying on a
-- prune pass nobody runs. doc_sections had to hand-roll its prune precisely
-- because a filesystem page has no referent to cascade from; a session turn does.
--
-- Vector width is 768 = PROSE_VECTOR_DIMS (migration 727's native
-- EmbeddingGemma-300m width). This column IS registered in
-- `PROSE_VECTOR_COLUMNS` (packages/operator-core/lib/search/prose-vector-dims.ts)
-- — an UNENUMERATED vector column is silently skipped by the next width
-- migration and fails prose-vector-dims.integration.test.ts by design.
--
-- The bare CREATE TABLE is unguarded (plain text columns need no extension);
-- the vector column + indexes are guarded on pgvector like 501/530/551/552 —
-- without the extension the sweep's column probe skips the target and the
-- transcript search leg stays on the parent vector alone (fail-open discipline).
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; files >=215).

CREATE TABLE IF NOT EXISTS harness_shared.session_turn_chunks (
  workspace_id text    NOT NULL DEFAULT 'default',
  source_kind  text    NOT NULL,
  session_id   text    NOT NULL,
  turn_idx     integer NOT NULL,
  chunk_idx    integer NOT NULL,
  content      text    NOT NULL,
  turn_sha     text    NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx, chunk_idx),
  CONSTRAINT session_turn_chunks_parent_fkey
    FOREIGN KEY (workspace_id, source_kind, session_id, turn_idx)
    REFERENCES harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx)
    ON DELETE CASCADE
);

-- The sync's change-detection read is "which parent turns do I already have
-- chunks for, and at what sha" — a per-turn lookup the PK prefix already
-- serves. What the PK does NOT serve is the sweep's freshest-first drain order
-- (P-005): without this, every batch full-sorts the whole backlog.
CREATE INDEX IF NOT EXISTS session_turn_chunks_updated_idx
  ON harness_shared.session_turn_chunks (updated_at);

DO $turn_chunks_embed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RETURN;
  END IF;

  ALTER TABLE harness_shared.session_turn_chunks
    ADD COLUMN IF NOT EXISTS embedding public.vector(768),
    ADD COLUMN IF NOT EXISTS embedding_mode text;

  -- Backfill hot predicate (mirrors 530/551/552): "rows not in the active
  -- space" = embedding IS NULL OR embedding_mode IS DISTINCT FROM $active.
  CREATE INDEX IF NOT EXISTS session_turn_chunks_embedding_mode_idx
    ON harness_shared.session_turn_chunks (embedding_mode)
    WHERE embedding_mode IS NOT NULL;

  -- HNSW cosine for the semantic leg (ORDER BY embedding <=> $query LIMIT k).
  CREATE INDEX IF NOT EXISTS session_turn_chunks_embedding_hnsw_idx
    ON harness_shared.session_turn_chunks USING hnsw (embedding public.vector_cosine_ops);
END
$turn_chunks_embed$;
