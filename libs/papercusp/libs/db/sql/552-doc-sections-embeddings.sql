-- Migration 552 — doc-section embedding store (P-009,
-- shared-embedding-sidecar-and-enrichment-2026-07-10).
--
-- docs:search is filesystem-backed (@papercusp/docs-engine DocSource adapters
-- render markdown on demand); there is NO content table to ALTER, so the
-- semantic leg gets its own derived store: one row per (source, page, section),
-- mirrored from the adapters by operator-core/lib/search/doc-embed-sync.ts
-- (sha-keyed text sync, embedding left NULL) and vectorized by the 5-min
-- embed-backfill sweep (TARGETS entry) under the 530/551 space discipline
-- (embedding_mode written with the vector; query side filters to the active
-- space; the sweep re-embeds rows whose mode IS DISTINCT FROM the active one).
--
-- source_key scopes rows to a docs surface exactly as the docs:search handler
-- resolves adapters: 'papercusp-engineering' (the Starlight engineering tree —
-- the agent-insights runbooks P-009 targets), 'project'
-- (PAPERCUSP_PROJECT_DOCS_ROOT), or 'harness:<slug>'. Deliberately NO
-- workspace_id: these rows are a derived cache of filesystem state, not tenant
-- data — the surface IS the scope, and keying by workspace would duplicate
-- identical sections per workspace and strand rows when the active workspace
-- changes.
--
-- The bare CREATE TABLE is unguarded (plain text columns need no extension);
-- the vector column + indexes are guarded on pgvector like 501/530/551 —
-- without the extension the sweep's column probe skips the target and
-- docs:search stays lexical-only (fail-open discipline).
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; files >=215).

CREATE TABLE IF NOT EXISTS harness_shared.doc_sections (
  source_key text NOT NULL,
  slug       text NOT NULL,
  anchor     text NOT NULL DEFAULT '',
  title      text NOT NULL DEFAULT '',
  url        text NOT NULL DEFAULT '',
  content    text NOT NULL DEFAULT '',
  page_sha   text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_key, slug, anchor)
);

DO $doc_embed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RETURN;
  END IF;

  ALTER TABLE harness_shared.doc_sections
    ADD COLUMN IF NOT EXISTS embedding public.vector(384),
    ADD COLUMN IF NOT EXISTS embedding_mode text;

  -- Backfill hot predicate (mirrors 530/551): "rows not in the active space" =
  -- embedding IS NULL OR embedding_mode IS DISTINCT FROM $active.
  CREATE INDEX IF NOT EXISTS doc_sections_embedding_mode_idx
    ON harness_shared.doc_sections (embedding_mode)
    WHERE embedding_mode IS NOT NULL;

  -- HNSW cosine for the semantic leg (ORDER BY embedding <=> $query LIMIT k).
  CREATE INDEX IF NOT EXISTS doc_sections_embedding_hnsw_idx
    ON harness_shared.doc_sections USING hnsw (embedding public.vector_cosine_ops);
END
$doc_embed$;
