-- Migration 551 — embedding columns for the work-item ledger (P-008,
-- shared-embedding-sidecar-and-enrichment-2026-07-10).
--
-- REVISED same-day: the first cut ALTERed harness_features_consolidated and
-- engineer_issues directly — both are compat VIEWS over the TRUE base table
-- harness_shared.work_items since migration 374 (work-items-unify-base-table),
-- so a fresh-baseline apply failed with "is not a table". The columns belong
-- on the BASE (one row-space = one embedding surface for BOTH families);
-- harness_features_consolidated (a plain `SELECT *` projection) is re-expanded
-- to surface them (the migration-485 pattern, append-only); the engineer_issues
-- view keeps its mapped column list untouched — issue-family consumers
-- (embed-backfill, work_items:search's semantic leg, the create-time dupe
-- prescreen) rank on the base table directly and hydrate through the view.
--
-- WHY: work_items:search gains a semantic leg and work_items:create can
-- prescreen new titles against OPEN items by cosine similarity (the 2026-07-10
-- 30-dupe bug-storm class, WI-3358..WI-3477, whose differently-worded titles
-- the lexical mirror-guard could not see).
--
-- Space discipline (migration 530 / EI-8913): the vector column alone is a
-- trap — `memoryEmbedderMode` picks the embedder at runtime, and two 384-D
-- vectors from different embedders are incomparable noise. `embedding_mode`
-- records WHICH embedder produced each row's vector; the embed-backfill sweep
-- re-embeds rows whose mode IS DISTINCT FROM the active one, and the query
-- side filters `embedding_mode = <active>` so it never ranks against a
-- foreign space.
--
-- Dimension: 384 (gemma MRL-384 / BGE / OpenAI-384 — every mode the backfill
-- stores; harrier@1024 is memory-side only and is skipped by the sweep's dims
-- guard). Guarded on pgvector being installed, like 501/530: without the
-- extension the columns are simply not created and every consumer fail-opens
-- to lexical-only.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; files >=215).

DO $wi_embed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RETURN;
  END IF;

  ALTER TABLE harness_shared.work_items
    ADD COLUMN IF NOT EXISTS embedding public.vector(384),
    ADD COLUMN IF NOT EXISTS embedding_mode text;

  -- Backfill hot predicate (mirrors 530): "rows not in the active space" =
  -- embedding IS NULL OR embedding_mode IS DISTINCT FROM $active. Indexing the
  -- non-null modes keeps that scan cheap once the table has been stamped.
  CREATE INDEX IF NOT EXISTS work_items_embedding_mode_idx
    ON harness_shared.work_items (embedding_mode)
    WHERE embedding_mode IS NOT NULL;

  -- HNSW cosine for the semantic search leg + the create-time dupe prescreen
  -- (ORDER BY embedding <=> $query LIMIT k). Same shape as memory_vec_* (547).
  CREATE INDEX IF NOT EXISTS work_items_embedding_hnsw_idx
    ON harness_shared.work_items USING hnsw (embedding public.vector_cosine_ops);

  -- Re-expand `SELECT *` so the feature-family compat view picks up the new
  -- trailing base columns (the migration-485 pattern: append-only, every
  -- existing view column keeps its name/type/position). The view is a plain
  -- filtered projection, so it stays auto-updatable — the backfill's UPDATE
  -- through it lands on the base rows. engineer_issues is deliberately NOT
  -- re-created: its column list is hand-mapped and its INSTEAD OF DML trigger
  -- (mig 388 lineage) would need extending; issue-family embedding access
  -- goes straight to the base table instead.
  CREATE OR REPLACE VIEW harness_shared.harness_features_consolidated AS
    SELECT * FROM harness_shared.work_items
    WHERE item_kind NOT IN ('bug', 'change', 'task')
    WITH CASCADED CHECK OPTION;
END
$wi_embed$;
