-- Migration 837 — consult_state: query_embedding for archive-first retrieval
-- (get-feedback-relevance-consults-2026-08-16 P-006 / D-005 "consults backfill
-- the retrieval cache", D-006 "retrieval, not consult").
--
-- Every consult INSERT stores the router's already-computed question embedding
-- so a future similar question can be served from the archive of
-- closed_answered consults (no wake, no budget consumption) when its cosine
-- similarity clears the archive floor. Rows from before this migration have no
-- embedding and are simply never archive-served (IS NOT NULL predicate); no
-- backfill machinery — the population predating this change is test rows only.
--
-- pgvector leg — column + HNSW index added ONLY when the extension is
-- installed (embedded-PG ships it; a bare dev PG may not). Absent, the
-- archive-first serve degrades to "always route normally" — same
-- degrade-to-BM25 contract as session_turns (migration 501).
--
-- Additive-only (expand): no destructive DDL, no FORWARD-COMPAT line needed.
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level
-- BEGIN/COMMIT — the migration runner wraps each file in its own transaction.

DO $vec$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE harness_shared.consult_state ADD COLUMN IF NOT EXISTS query_embedding vector(384)';
    -- HNSW needs pgvector >= 0.5; guard so an older extension just skips it
    -- (cosine scans still work, only slower). Partial: only embedded rows are
    -- candidates, and the planner can use the predicate for the IS NOT NULL
    -- archive lookup.
    BEGIN
      EXECUTE 'CREATE INDEX IF NOT EXISTS consult_state_query_embedding_idx
                 ON harness_shared.consult_state
              USING hnsw (query_embedding vector_cosine_ops)
               WHERE query_embedding IS NOT NULL';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'consult_state: hnsw index skipped (%)', SQLERRM;
    END;
  END IF;
END
$vec$;
