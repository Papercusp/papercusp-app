-- 061-semantic-search.sql
--
-- Plan 2B+C — embedding-similarity columns on the 3 BM25 surfaces and
-- the helper view for the RRF (Reciprocal Rank Fusion) combiner.
--
-- Wire shape:
--   harness_shared.harness_escalations.body_embedding  vector(384)
--   harness_shared.harness_brainstorm.content_embedding vector(384)
--   harness_shared.operator_turns.text_embedding       vector(384)
--
-- 384 to match mem0's per-mode collections (OpenAI text-embedding-3-small
-- truncated to 384 dims, BGE-small native 384). Same wire = future
-- cross-pollination between mem0 memories and historical surfaces.
--
-- HNSW index per column (cosine ops). HNSW is the sweet spot for
-- moderate dataset sizes (<1M rows) — faster build than IVF, no
-- need to re-build after inserts, good recall at low ef_search.
--
-- Columns start NULL. A boot-time backfill worker
-- (lib/search/embed-backfill.ts) walks ungilded rows and fills them
-- using the configured embedder (mem0's same cascade). Cheap rows
-- (short text) embed first; long rows last. Backfill is cancellable
-- and resumable on next boot.

-- Pgvector must already be installed (migration 060). If it isn't,
-- this migration becomes a no-op (we still add tsvector columns
-- but skip vector ones).

DO LANGUAGE plpgsql $body$
DECLARE
  has_vector boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') INTO has_vector;
  IF NOT has_vector THEN
    RAISE NOTICE 'pgvector extension not installed; skipping vector columns. Semantic search will be unavailable until migration 060 succeeds.';
    RETURN;
  END IF;

  -- harness_escalations
  EXECUTE 'ALTER TABLE harness_shared.harness_escalations ADD COLUMN IF NOT EXISTS body_embedding vector(384)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS harness_escalations_body_embedding_hnsw ON harness_shared.harness_escalations USING hnsw (body_embedding vector_cosine_ops)';

  -- harness_brainstorm
  EXECUTE 'ALTER TABLE harness_shared.harness_brainstorm ADD COLUMN IF NOT EXISTS content_embedding vector(384)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS harness_brainstorm_content_embedding_hnsw ON harness_shared.harness_brainstorm USING hnsw (content_embedding vector_cosine_ops)';

  -- operator_turns
  EXECUTE 'ALTER TABLE harness_shared.operator_turns ADD COLUMN IF NOT EXISTS text_embedding vector(384)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS operator_turns_text_embedding_hnsw ON harness_shared.operator_turns USING hnsw (text_embedding vector_cosine_ops)';

  -- Replica identity for logical replication. The 3 surfaces are
  -- published via `zero_harness` and need REPLICA IDENTITY for the
  -- backfill worker's UPDATE statements to succeed. operator_turns
  -- in particular has no primary key — only NOT NULL on id — so
  -- DEFAULT can't be used. FULL is safe because backfill writes are
  -- infrequent (boot-time sweep + occasional re-embed) and the row
  -- bodies are small (prose, not blobs).
  EXECUTE 'ALTER TABLE harness_shared.harness_escalations REPLICA IDENTITY FULL';
  EXECUTE 'ALTER TABLE harness_shared.harness_brainstorm  REPLICA IDENTITY FULL';
  EXECUTE 'ALTER TABLE harness_shared.operator_turns      REPLICA IDENTITY FULL';

  RAISE NOTICE 'pgvector columns + HNSW indexes added; embed-backfill worker will populate on next boot.';
END
$body$;
