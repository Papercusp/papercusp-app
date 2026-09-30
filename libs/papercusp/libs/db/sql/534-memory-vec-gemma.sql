-- Migration 534 — harness_shared.memory_vec_gemma (EmbeddingGemma-300m embedder space).
--
-- EmbeddingGemma-300m becomes the DEFAULT local embedder (owner ask 2026-07-10).
-- It is a DISTINCT embedding SPACE from BGE-small ('local') and OpenAI ('openai'):
-- a Gemma-384 vector and a BGE-384 vector are the same DIMENSION but different
-- SPACES — cosine between them is meaningless (the embedding-space-vs-dimension
-- scar / EI-8913). So Gemma gets its OWN per-mode vec table, exactly like the
-- existing two, rather than re-pointing 'local' (which would silently invalidate
-- every stored BGE vector).
--
-- Dimension: EmbeddingGemma is natively 768-dim (MRL-truncatable); we truncate to
-- 384 + L2-renormalize so it reuses the existing vector(384) column shape here AND
-- in the 5 shared-column prose surfaces (no wide column migration). Full 768 is a
-- deferred max-quality follow-up.
--
-- Mirrors memory_vec_local / memory_vec_openai (baseline / migration 081): same
-- columns, PK, ON DELETE CASCADE FK to memory_canonical, and HNSW cosine index.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; lint:migrations,
-- files >=215).

CREATE TABLE IF NOT EXISTS harness_shared.memory_vec_gemma (
    memory_id uuid NOT NULL,
    vector public.vector(384) NOT NULL,
    embedded_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  ALTER TABLE ONLY harness_shared.memory_vec_gemma
    ADD CONSTRAINT memory_vec_gemma_pkey PRIMARY KEY (memory_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
  WHEN wrong_object_type THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE ONLY harness_shared.memory_vec_gemma
    ADD CONSTRAINT memory_vec_gemma_memory_id_fkey FOREIGN KEY (memory_id)
      REFERENCES harness_shared.memory_canonical(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
  WHEN wrong_object_type THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS memory_vec_gemma_hnsw_idx
  ON harness_shared.memory_vec_gemma USING hnsw (vector public.vector_cosine_ops);
