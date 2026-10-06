-- Migration 1341 — a partial HNSW index over consult_questions' chunks
-- (generic-rag-chunking-2026-09-29 P-016, decision D-046).
--
-- WHY. coord:orient's peers-know lookup ranks the settled consult questions
-- of one workspace by the nearer of each question's own vector and its
-- chunks' vectors. Its chunk leg ranked those chunks exactly: one probe of
-- text_chunks_pkey per settled parent (about 300) and about 330 TOASTed
-- 3,076-byte vectors detoasted per lookup. That leg alone added about 8 ms at
-- p95 against a 3.5 ms budget (D-043, D-045).
--
-- WHAT. An HNSW index over the chunk vectors of the consult_questions surface
-- only. The chunk leg now reads text_chunks alone, names the surface as a
-- literal (so this partial index matches under a generic plan) and tests slice
-- membership as a filter (@papercusp/search chunkAwareVectorLegSql
-- chunkScan:'ann'). Measured on the live table: the planner uses this index,
-- p50/p95 3.60/5.04 ms against 4.95/5.92 for the exact leg, and top-1 equal to
-- the exact leg's on 90 of 90 queries at hnsw.ef_search 100.
--
-- The whole-table index text_chunks_embedding_hnsw_idx (migration 1242) stays:
-- the other surfaces' ANN legs read it. A partial index per surface for those
-- is a separate follow-up (D-046 point 5).
--
-- Not CONCURRENTLY: the runner applies each file inside a transaction, where
-- CREATE INDEX CONCURRENTLY is refused. Built in 1.4-2.5 s over about 2,950
-- chunks (measured 2026-10-02), so the write lock it holds is brief.

CREATE INDEX IF NOT EXISTS text_chunks_consult_questions_embedding_hnsw_idx
  ON harness_shared.text_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE surface = 'consult_questions';
