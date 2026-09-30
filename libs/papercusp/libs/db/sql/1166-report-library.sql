-- 1166-report-library.sql — Owner-facing reports library
-- Plan reports-library-2026-09-15, P-001. Additive only: two new tables, no
-- destructive DDL, so no FORWARD-COMPAT acknowledgment is required.
--
-- WHY A NEW RELATION RATHER THAN AN EXISTING ONE (plan D-002):
--   * harness_shared.harness_text_artifacts is (harness_slug, rel_path, content,
--     updated_at, workspace_id) — a raw generated-text store with no title,
--     summary, subject, visibility or lineage. Every field below would have to
--     be smuggled into rel_path.
--   * harness_shared.pot_reports is the MODERATION table (reporter_github_user_id,
--     target_kind/target_ref, report_reason, status) — same English word, wholly
--     unrelated concept. Hence the name `report_library`, which cannot collide
--     with it or with telemetry_reports.
--   * harness_docs carries code-drift/regeneration semantics that are wrong for a
--     deliverable written FOR a person ABOUT something possibly outside the pot.
--
-- The three independent axes (plan D-001) are origin_* (where it was written),
-- subject_* (what it is about — may be entirely external), and visibility (who
-- may read it). No column does two of those jobs.

CREATE TABLE IF NOT EXISTS harness_shared.report_library (
    workspace_id          text        NOT NULL,
    report_id             text        NOT NULL,

    -- what it is
    title                 text        NOT NULL,
    summary               text        NOT NULL DEFAULT ''::text,
    body_md               text        NOT NULL DEFAULT ''::text,
    kind                  text        NOT NULL DEFAULT 'audit'::text,

    -- axis 2: what it is ABOUT (may be outside this workspace entirely)
    subject_kind          text        NOT NULL DEFAULT 'none'::text,
    subject_ref           text,
    subject_label         text,

    -- axis 1: where it came FROM (server-stamped, never caller-supplied)
    origin_harness_slug   text,
    author_owner_id       text,
    author_session_ref    text,

    -- axis 3: who may READ it
    visibility            text        NOT NULL DEFAULT 'owner'::text,

    -- lineage: a redone audit supersedes its predecessor (plan D-004)
    supersedes_report_id  text,
    lineage_id            text        NOT NULL,

    source                text        NOT NULL DEFAULT 'agent'::text,
    tags                  text[]      NOT NULL DEFAULT '{}'::text[],

    published_at          timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    retired_at            timestamptz,

    CONSTRAINT report_library_pkey PRIMARY KEY (workspace_id, report_id)
);

-- Lexical leg input. Title and summary are weighted above the body so a report
-- ABOUT a topic outranks one that merely mentions it in passing.
ALTER TABLE harness_shared.report_library
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(subject_label, '')), 'B') ||
      setweight(to_tsvector('english', left(coalesce(body_md, ''), 200000)), 'C')
  ) STORED;

DO $report_library_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.report_library'::regclass
       AND conname = 'report_library_kind_allowed'
  ) THEN
    ALTER TABLE harness_shared.report_library
      ADD CONSTRAINT report_library_kind_allowed
      CHECK (kind IN ('audit','review','analysis','postmortem','status-digest','proposal','other'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.report_library'::regclass
       AND conname = 'report_library_visibility_allowed'
  ) THEN
    ALTER TABLE harness_shared.report_library
      ADD CONSTRAINT report_library_visibility_allowed
      CHECK (visibility IN ('owner','pot','workspace'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.report_library'::regclass
       AND conname = 'report_library_subject_kind_allowed'
  ) THEN
    ALTER TABLE harness_shared.report_library
      ADD CONSTRAINT report_library_subject_kind_allowed
      CHECK (subject_kind IN ('pot','plan','work_item','fleet','goal','repo','external','none'));
  END IF;

  -- A subject that is not 'none' must actually name something; otherwise the
  -- subject axis silently degrades back into "whatever pot wrote it".
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.report_library'::regclass
       AND conname = 'report_library_subject_ref_present'
  ) THEN
    ALTER TABLE harness_shared.report_library
      ADD CONSTRAINT report_library_subject_ref_present
      CHECK (subject_kind = 'none' OR coalesce(btrim(subject_ref), '') <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.report_library'::regclass
       AND conname = 'report_library_title_present'
  ) THEN
    ALTER TABLE harness_shared.report_library
      ADD CONSTRAINT report_library_title_present
      CHECK (btrim(title) <> '');
  END IF;
END
$report_library_checks$;

-- The library list: newest first, retired rows excluded.
CREATE INDEX IF NOT EXISTS report_library_published_idx
    ON harness_shared.report_library (workspace_id, published_at DESC)
    WHERE retired_at IS NULL;

-- Lineage collapse (latest per lineage) and the history view behind it.
CREATE INDEX IF NOT EXISTS report_library_lineage_idx
    ON harness_shared.report_library (workspace_id, lineage_id, published_at DESC);

-- "every report about X", the subject axis's reason for existing.
CREATE INDEX IF NOT EXISTS report_library_subject_idx
    ON harness_shared.report_library (workspace_id, subject_kind, subject_ref);

CREATE INDEX IF NOT EXISTS report_library_kind_idx
    ON harness_shared.report_library (workspace_id, kind, published_at DESC);

CREATE INDEX IF NOT EXISTS report_library_origin_idx
    ON harness_shared.report_library (workspace_id, origin_harness_slug, published_at DESC);

CREATE INDEX IF NOT EXISTS report_library_tsv_idx
    ON harness_shared.report_library USING gin (search_tsv);

CREATE INDEX IF NOT EXISTS report_library_tags_idx
    ON harness_shared.report_library USING gin (tags);

-- Semantic leg. Chunked because a report body is long-form prose; width is
-- PROSE_VECTOR_DIMS (768, per migration 727 — see
-- packages/operator-core/lib/search/prose-vector-dims.ts, whose test asserts
-- the constant and this column agree).
CREATE TABLE IF NOT EXISTS harness_shared.report_library_chunks (
    workspace_id            text    NOT NULL,
    report_id               text    NOT NULL,
    chunk_idx               integer NOT NULL,
    text                    text    NOT NULL,
    embedding               public.vector(768),
    text_embedding_mode     text,
    text_embedding_profile  text,
    embedded_at             timestamptz,

    CONSTRAINT report_library_chunks_pkey PRIMARY KEY (workspace_id, report_id, chunk_idx),
    CONSTRAINT report_library_chunks_report_fk
        FOREIGN KEY (workspace_id, report_id)
        REFERENCES harness_shared.report_library (workspace_id, report_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS report_library_chunks_embedding_hnsw
    ON harness_shared.report_library_chunks
    USING hnsw (embedding public.vector_cosine_ops);

-- Backfill/repair sweeps ask "which chunks still have no vector?"
CREATE INDEX IF NOT EXISTS report_library_chunks_unembedded_idx
    ON harness_shared.report_library_chunks (workspace_id, report_id)
    WHERE embedding IS NULL;
