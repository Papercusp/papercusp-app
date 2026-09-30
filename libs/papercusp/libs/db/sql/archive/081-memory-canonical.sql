-- 081-memory-canonical.sql
--
-- Per-text canonical memory store + per-embedder-model vector views.
-- Replaces mem0's per-collection split (`operator_memory_openai` /
-- `operator_memory_local`) which duplicated the text + metadata across
-- two tables and forced the "switch mode = lose your memories" UX.
--
-- New shape:
--   memory_canonical   — one row per fact (id, payload jsonb, ts)
--   memory_vec_openai  — (memory_id pk fk, vector(384))     [HNSW cosine]
--   memory_vec_local   — (memory_id pk fk, vector(384))     [HNSW cosine]
--
-- Switching embedder mode now changes only which vec table the recall
-- side reads; the canonical row is untouched. Re-embedding into the
-- other model becomes an INSERT into the other vec table without
-- touching the canonical row. A row can have vectors in both, one, or
-- (transiently, between write and embed) neither table.
--
-- Wired via the in-process CanonicalVectorStore (apps/operator/lib/
-- memory/canonical-store.ts), registered against mem0's
-- VectorStoreFactory by mem0-client.ts at first construction.
--
-- Requires pgvector (migration 060). Idempotent + non-destructive.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.memory_canonical (
  id          uuid        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- payload->>'user_id' is the scope key (user uuid, "harness:<slug>",
-- "workspace:<wsId>"). Per-key BTREE index keeps the pool-scoped
-- queries (search/list) cheap.
CREATE INDEX IF NOT EXISTS memory_canonical_user_id_idx
  ON harness_shared.memory_canonical ((payload->>'user_id'));

CREATE TABLE IF NOT EXISTS harness_shared.memory_vec_openai (
  memory_id   uuid        NOT NULL PRIMARY KEY
    REFERENCES harness_shared.memory_canonical(id) ON DELETE CASCADE,
  vector      vector(384) NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_vec_openai_hnsw_idx
  ON harness_shared.memory_vec_openai USING hnsw (vector vector_cosine_ops);

CREATE TABLE IF NOT EXISTS harness_shared.memory_vec_local (
  memory_id   uuid        NOT NULL PRIMARY KEY
    REFERENCES harness_shared.memory_canonical(id) ON DELETE CASCADE,
  vector      vector(384) NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_vec_local_hnsw_idx
  ON harness_shared.memory_vec_local USING hnsw (vector vector_cosine_ops);

COMMIT;
