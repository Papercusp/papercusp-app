-- Migration 172 — harness_shared.harness_docs: typed, drift-tracked doc records.
--
-- Plan: harness-docs-integration-2026-06-05 (P-002 / D-002 / D-007).
--
-- Per-harness project docs are today FS-only markdown (GET
-- /api/harness/:slug/project-docs walks <repo>/docs/) with no metadata, no DB,
-- and no link to the code they document. This table is the PG **runtime
-- store-of-record** for the doc RECORD; per the two-axis storage policy
-- (/internal/docs/system/storage-policy) and D-007, the doc BODY stays a markdown
-- file in the harness repo (git is the sync authority for document tables — it's
-- where the `documenter` writes generated docs and git-sync commits them). So
-- this table holds ONLY what isn't in the file: the typed drift anchor, baseline
-- SHAs, the augmented human overlay (which must survive a regeneration that
-- overwrites the generated file), and a derived freshness cache.
--
--   doc_id           = repo-relative doc path (e.g. 'features/F-001.md') — stable key
--   source           = generated | manual | augmented (D-003)
--   subject_ref      = jsonb SubjectRef[] — typed union {path|symbol|feature} (D-001)
--   anchor_paths     = denormalised reverse index (resolved globs/files) for the
--                      git-sync freshness sweep (P-003); derived from subject_ref
--   generated_from_sha = baseline for generated / augmented generated-half
--   last_verified_sha/_at = baseline for manual (set when a human verifies)
--   overlay          = augmented human overlay markdown (survives regen; D-003/P-005)
--   status           = derived freshness cache: fresh|stale|review|untracked|unknown
--                      (recomputable from records + git — a cache, not a mirror; D-002)
--
-- Classification: workspace-owned. Mirrors harness_plans (mig 122) shape: blob-
-- adjacent metadata + derived index + federation-ready columns. Idempotent
-- (CREATE ... IF NOT EXISTS + guarded constraints/grants); runs as harness_admin
-- and composes onto 000-baseline.sql for fresh / embedded-pg boots.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.harness_docs (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    doc_id text NOT NULL,                          -- repo-relative doc path (stable key)

    source text DEFAULT 'manual'::text NOT NULL,   -- generated | manual | augmented (D-003)

    -- The drift anchor (D-001). SubjectRef[] typed union; anchor_paths is the
    -- resolved reverse-index projection the sweep matches changed paths against.
    subject_ref jsonb DEFAULT '[]'::jsonb NOT NULL,
    anchor_paths text[] DEFAULT '{}'::text[] NOT NULL,

    -- Baselines: which strategy's SHA is "known current" for staleness.
    generated_from_sha text,                       -- generated / augmented generated-half
    last_verified_sha text,                        -- manual
    last_verified_at timestamp with time zone,

    -- Augmented human overlay (D-003/P-005). NULL for pure generated/manual.
    overlay text,

    -- Derived freshness cache (D-002). The git-sync sweep (P-003) flips this; the
    -- forward on-demand query recomputes it. status_detail carries a short why
    -- (changed paths / git error) for the "⚠ may be out of date" tooltip.
    status text DEFAULT 'untracked'::text NOT NULL,
    status_detail text,
    status_checked_at timestamp with time zone,

    -- Close-the-loop bookkeeping (D-004): when a generated stale doc's
    -- regeneration was enqueued / a manual re-verify task was raised, so the
    -- sweep doesn't re-enqueue every tick.
    regen_enqueued_at timestamp with time zone,
    reverify_flagged_at timestamp with time zone,

    -- Derived index (optional, for cheap list rendering).
    title text,

    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,

    -- Federation-ready (mirrors harness_plans / harness_features_consolidated).
    author_pubkey text,
    origin text DEFAULT 'local'::text NOT NULL,

    CONSTRAINT harness_docs_source_check
      CHECK (source = ANY (ARRAY['generated'::text, 'manual'::text, 'augmented'::text])),
    CONSTRAINT harness_docs_status_check
      CHECK (status = ANY (ARRAY['fresh'::text, 'stale'::text, 'review'::text, 'untracked'::text, 'unknown'::text])),
    CONSTRAINT harness_docs_workspace_nonempty CHECK ((workspace_id <> ''::text)),
    CONSTRAINT harness_docs_doc_id_nonempty CHECK ((doc_id <> ''::text))
);

DO $baseline_guard$ BEGIN
  ALTER TABLE ONLY harness_shared.harness_docs
    ADD CONSTRAINT harness_docs_pkey PRIMARY KEY (workspace_id, harness_slug, doc_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $baseline_guard$;

COMMENT ON TABLE harness_shared.harness_docs IS
  'Typed, drift-tracked per-harness doc records (harness-docs-integration-2026-06-05). PG is the runtime store-of-record for the metadata + augmented overlay; the doc BODY stays a markdown file in the harness repo (git is the document sync authority; D-007). subject_ref is the typed drift anchor (D-001); status is a derived freshness cache (D-002).';

-- Reverse index: match git-sync changed paths → docs cheaply (P-003).
CREATE INDEX IF NOT EXISTS harness_docs_anchor_paths_idx
  ON harness_shared.harness_docs USING gin (anchor_paths);

-- The sweep + tabs filter by (workspace, harness) and by status.
CREATE INDEX IF NOT EXISTS harness_docs_status_idx
  ON harness_shared.harness_docs USING btree (workspace_id, harness_slug, status);

-- Auto-bump updated_at on every write (mirrors harness_plans mig 122).
CREATE OR REPLACE FUNCTION harness_shared.set_harness_docs_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS harness_docs_updated_at_trg ON harness_shared.harness_docs;
CREATE TRIGGER harness_docs_updated_at_trg
  BEFORE UPDATE ON harness_shared.harness_docs
  FOR EACH ROW EXECUTE FUNCTION harness_shared.set_harness_docs_updated_at();

-- RLS: workspace isolation (mirrors harness_plans). harness_admin has BYPASSRLS
-- (mig 016) for backfills + cross-harness reads; harness_app is app.workspace_id-scoped.
ALTER TABLE harness_shared.harness_docs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS harness_docs_workspace_isolation ON harness_shared.harness_docs;
CREATE POLICY harness_docs_workspace_isolation ON harness_shared.harness_docs
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_docs TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.harness_docs TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMIT;
