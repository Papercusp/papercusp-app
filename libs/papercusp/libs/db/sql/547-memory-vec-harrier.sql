-- Migration 547 — harness_shared.memory_vec_harrier (harrier-oss-v1-0.6b embedder space).
--
-- Harrier becomes a first-class SELECTABLE embedder mode (P-014,
-- shared-embedding-sidecar-and-enrichment-2026-07-10) — NOT the default:
-- adoption as default is gated on a P-006 gold-set win outside noise. It is a
-- DISTINCT embedding SPACE from gemma, BGE ('local'), and OpenAI (the
-- embedding-space-vs-dimension scar / EI-8913), so it gets its OWN per-mode
-- vec table, exactly like migrations 081/534.
--
-- Dimension: NATIVE 1024 — harrier has no documented MRL, so unlike gemma we
-- do NOT truncate for memory-side storage; the truncated-384 variant exists
-- only behind the P-001 eval gate for prose-surface exploration. The graph
-- output is last-token pooled + L2-normalized in the ONNX export itself.
--
-- Mirrors memory_vec_gemma (migration 534): same columns, PK, ON DELETE
-- CASCADE FK to memory_canonical, and HNSW cosine index (pgvector hnsw
-- supports up to 2000 dims; 1024 is fine).
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; lint:migrations,
-- files >=215).

CREATE TABLE IF NOT EXISTS harness_shared.memory_vec_harrier (
    memory_id uuid NOT NULL,
    vector public.vector(1024) NOT NULL,
    embedded_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  ALTER TABLE ONLY harness_shared.memory_vec_harrier
    ADD CONSTRAINT memory_vec_harrier_pkey PRIMARY KEY (memory_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
  WHEN wrong_object_type THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE ONLY harness_shared.memory_vec_harrier
    ADD CONSTRAINT memory_vec_harrier_memory_id_fkey FOREIGN KEY (memory_id)
      REFERENCES harness_shared.memory_canonical(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
  WHEN wrong_object_type THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS memory_vec_harrier_hnsw_idx
  ON harness_shared.memory_vec_harrier USING hnsw (vector public.vector_cosine_ops);
