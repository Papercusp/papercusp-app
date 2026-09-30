-- Migration 847 — widen consult_state.query_embedding + interest_watches.embedding to vector(768)
--
-- WHY: migrations 837 (consult_state.query_embedding) and 839 (interest_watches.embedding)
-- added NEW vector(384) columns AFTER migration 727 had already cut the whole prose-embedding
-- surface over to gemma-native vector(768) — exactly the stranding 727's own comments warn
-- about ("a missed surface keeps vector(384) under 768-emitting code"). The live query
-- embedder emits 768-dim vectors, so:
--   * consult:get_feedback dies on its routing-snapshot INSERT with
--     "expected 384 dimensions, not 768" (the archive-first SELECT survives only while the
--     table has zero non-NULL embeddings — the <=> operator never evaluates — so the
--     embeddingColumnOk probe passes and the uncaught INSERT then throws). EI-20816404371786180
--     fixed the router's column names; this dimension mismatch was the second, independent
--     killer behind it.
--   * interest_watches writes (watch:create semantic interest) fail the same way, and any
--     stored 384 vector would make the sweep's SQL cosine match against
--     session_turns.text_embedding vector(768) throw per-row.
--
-- Both tables measured EMPTY (0 rows) at authoring time (2026-08-18T19:15Z), so USING NULL
-- loses nothing; a row that appears between authoring and apply carries either a NULL
-- embedding (converts trivially) or could not have been written at all (the 768 write is
-- what fails today).
--
-- FORWARD-COMPAT: the DROP INDEX below is recreated under the SAME name at the new width in
-- this same DO block; the currently-deployed release reads consult_state_query_embedding_idx
-- only via the archive-first probe, which tolerates any failure by degrading
-- (embeddingColumnOk=false), and both tables are empty — so no serving code path can observe
-- the drop/recreate window.

DO $$
DECLARE
  cur_dims int;
BEGIN
  -- consult_state.query_embedding: 384 -> 768 (+ partial HNSW index rebuild)
  IF to_regclass('harness_shared.consult_state') IS NOT NULL THEN
    SELECT a.atttypmod INTO cur_dims
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = 'consult_state'
       AND a.attname = 'query_embedding'
       AND a.attnum > 0 AND NOT a.attisdropped;
    IF cur_dims IS NOT NULL AND cur_dims <> 768 THEN
      EXECUTE 'DROP INDEX IF EXISTS harness_shared.consult_state_query_embedding_idx';
      EXECUTE 'ALTER TABLE harness_shared.consult_state
                 ALTER COLUMN query_embedding TYPE vector(768) USING NULL::vector(768)';
      EXECUTE 'CREATE INDEX IF NOT EXISTS consult_state_query_embedding_idx
                   ON harness_shared.consult_state
                USING hnsw (query_embedding vector_cosine_ops)
                WHERE query_embedding IS NOT NULL';
      RAISE NOTICE '847: consult_state.query_embedding widened % -> 768', cur_dims;
    ELSE
      RAISE NOTICE '847: consult_state.query_embedding already 768 or absent (dims=%) — skipped', cur_dims;
    END IF;
  END IF;

  -- interest_watches.embedding: 384 -> 768 (no index on this column; defensive drop anyway)
  IF to_regclass('harness_shared.interest_watches') IS NOT NULL THEN
    cur_dims := NULL;
    SELECT a.atttypmod INTO cur_dims
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = 'interest_watches'
       AND a.attname = 'embedding'
       AND a.attnum > 0 AND NOT a.attisdropped;
    IF cur_dims IS NOT NULL AND cur_dims <> 768 THEN
      EXECUTE 'DROP INDEX IF EXISTS harness_shared.interest_watches_embedding_idx';
      EXECUTE 'ALTER TABLE harness_shared.interest_watches
                 ALTER COLUMN embedding TYPE vector(768) USING NULL::vector(768)';
      RAISE NOTICE '847: interest_watches.embedding widened % -> 768', cur_dims;
    ELSE
      RAISE NOTICE '847: interest_watches.embedding already 768 or absent (dims=%) — skipped', cur_dims;
    END IF;
  END IF;
END $$;
