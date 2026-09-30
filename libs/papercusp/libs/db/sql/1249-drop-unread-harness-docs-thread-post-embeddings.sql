-- 1249: drop two vectors nothing reads:
--   harness_shared.harness_docs.embedding            (+ mode, profile, 2 indexes)
--   harness_shared.coord_thread_posts.body_embedding (+ mode, profile, 2 indexes)
--
-- generic-rag-chunking-2026-09-29 P-013 / D-025 (EI-24609404813504679), the same
-- verdict D-020 / migration 1243 gave carry_notes.note_embedding. Measured
-- 2026-09-30: no query in packages/, libs/ or apps/ applies a pgvector operator
-- to either column. The only references were the embed-backfill TARGETS entry
-- (the writer), the prose-vector-dims width registration and the generated
-- schema/index manifests.
--   * harness_docs reaches docs:search through doc_sections (source_key
--     harness:<slug>, D-007), which P-013 syncs on the sweep. docs:search never
--     read the in-row vector (1,193 rows, all embedded, none read).
--   * coord_thread_posts: migration 1097 added the vector "without wiring either
--     table into a query-time consumer", and none was ever wired. 1.1M vectors
--     and a 4.3 GB HNSW index that nothing touched. Threads stay findable
--     lexically via body_tsv (kept).
-- The same change removes both TARGETS entries and both registrations, and adds
-- embed-target-readers.test.ts: every TARGET must name a search site that reads
-- its vector, so a write-only vector cannot come back unnoticed.
--
-- FORWARD-COMPAT: the release still serving on :3070 touches these columns only from the embed-backfill TARGETS sweep, the embed-coverage sampler and embed-space-self-check, and each of those runs every target inside its own try/catch, so until this change deploys the two targets just log one warning per sweep; nothing else in the deployed code reads or writes these columns.

DROP INDEX IF EXISTS harness_shared.harness_docs_embedding_hnsw_idx;
DROP INDEX IF EXISTS harness_shared.harness_docs_embedding_mode_idx;
DROP INDEX IF EXISTS harness_shared.coord_thread_posts_embedding_hnsw_idx;
DROP INDEX IF EXISTS harness_shared.coord_thread_posts_embedding_mode_idx;

ALTER TABLE harness_shared.harness_docs
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_mode,
  DROP COLUMN IF EXISTS embedding_profile;

ALTER TABLE harness_shared.coord_thread_posts
  DROP COLUMN IF EXISTS body_embedding,
  DROP COLUMN IF EXISTS body_embedding_mode,
  DROP COLUMN IF EXISTS body_embedding_profile;
