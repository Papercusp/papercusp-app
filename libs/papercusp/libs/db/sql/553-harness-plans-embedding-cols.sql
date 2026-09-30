-- Migration 553 — embedding columns for the plan store (P-010,
-- shared-embedding-sidecar-and-enrichment-2026-07-10).
--
-- harness_shared.harness_plans is a BASE TABLE — pg_views checked: nothing
-- projects from it (the 551 view scar does not apply). Same shape as 551/552
-- under the 530 space discipline: the vector and `embedding_mode` are written
-- together by the embed-backfill sweep (TARGETS entry embeds
-- title + left(content, 2000)); the query side filters
-- `embedding_mode = <active>` so it never ranks against a foreign space.
--
-- WHY: plans:search gains a recall-additive semantic leg, and plans:new's
-- similar_exists token guard gains a cosine CONFIRMATION step — the token
-- matcher scores slug+title token overlap only, so topically-adjacent but
-- distinct efforts false-positive (it flagged this very plan's creation);
-- a token-flagged candidate whose stored vector is semantically distant from
-- the proposed plan no longer blocks creation.
--
-- Guarded on pgvector like 501/530/551/552: without the extension the columns
-- are not created and both consumers fail-open (lexical-only search,
-- token-only dedup).
--
-- The migration runner wraps each file in its own transaction — no
-- BEGIN;/COMMIT; here (migration-runner contract; files >=215).

DO $plan_embed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RETURN;
  END IF;

  ALTER TABLE harness_shared.harness_plans
    ADD COLUMN IF NOT EXISTS embedding public.vector(384),
    ADD COLUMN IF NOT EXISTS embedding_mode text;

  -- Backfill hot predicate (mirrors 530/551/552).
  CREATE INDEX IF NOT EXISTS harness_plans_embedding_mode_idx
    ON harness_shared.harness_plans (embedding_mode)
    WHERE embedding_mode IS NOT NULL;

  -- HNSW cosine for the semantic leg + the plans:new confirmation lookup.
  CREATE INDEX IF NOT EXISTS harness_plans_embedding_hnsw_idx
    ON harness_shared.harness_plans USING hnsw (embedding public.vector_cosine_ops);
END
$plan_embed$;
