-- Migration 122 — harness_shared.harness_plans: PG-canonical plan storage.
--
-- Plan: plans-pg-canonical-migration-2026-06-03 (Stage 0 — Foundation, additive).
--
-- Today a plan is a filesystem-canonical markdown file at
-- apps/operator/docs/plans/<slug>-<YYYY-MM-DD>.md. This table makes PG the
-- single source of truth (D-001): `content` TEXT holds the canonical markdown
-- blob through the file-removal stage (D-002 lift-and-shift); the queryable
-- frontmatter is mirrored into columns as a derived index. The folded
-- `op_*` columns absorb harness_plan_status (mig 086) so list/start/pause read
-- one row (D-007).
--
-- Stage boundaries this migration respects:
--   * Stage 0 (here): the table only — blob-canonical, federation-READY columns
--     (origin/author_pubkey) but NO capture trigger yet (a later federation
--     migration attaches capture_substrate_outbox once the plans projection is
--     registered, so the outbox doesn't accumulate undrained rows).
--   * Stage 3 (later migration): adds the structured derived-index columns
--     (items/decisions/now) — prose stays canonical in `content` (D-006).
--
-- Classification (table-registry.ts): workspace-owned + sync:peer-log (D-004/D-008)
-- — plans federate as papercup-harness content over the existing peer-log machinery.
--
-- Idempotent: CREATE ... IF NOT EXISTS + guarded constraints/grants. Runs as
-- harness_admin (the migration role); composes onto 000-baseline.sql for fresh
-- / embedded-pg boots and applies cleanly on the native :5432 dev box.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.harness_plans (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    plan_slug text NOT NULL,

    -- Frontmatter (derived index over the canonical blob).
    title text,
    status text,
    created text,            -- authored frontmatter date string (e.g. '2026-06-03')
    updated text,            -- authored frontmatter date string
    owner text,
    supersedes text[] DEFAULT '{}'::text[] NOT NULL,
    superseded_by text,

    -- Canonical content (D-002 blob through Stage 2).
    content text DEFAULT ''::text NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,   -- sha256(content); app-maintained, mirrors content-hash.ts
    version bigint DEFAULT 0 NOT NULL,             -- optimistic CAS guard (D-005)

    -- Operational status folded from harness_plan_status (mig 086; D-007).
    op_status text,                                -- started | paused | done | NULL (not started)
    op_started_at timestamp with time zone,
    op_updated_at timestamp with time zone,
    current_wave text,
    op_priority integer,

    archived boolean DEFAULT false NOT NULL,
    is_legacy boolean DEFAULT false NOT NULL,

    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,

    -- Federation (peer-log; mirrors harness_features_consolidated). The
    -- capture trigger + plans projection arrive in the Stage-2 federation
    -- migration; these columns make the row capture-ready now.
    author_pubkey text,
    origin text DEFAULT 'local'::text NOT NULL,

    _search tsvector GENERATED ALWAYS AS (
      (setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char")
       || setweight(to_tsvector('english'::regconfig, COALESCE(content, ''::text)), 'B'::"char"))
    ) STORED,

    CONSTRAINT harness_plans_status_check
      CHECK ((status IS NULL) OR (status = ANY (ARRAY['draft'::text, 'ready'::text, 'active'::text, 'shipped'::text, 'superseded'::text]))),
    CONSTRAINT harness_plans_op_status_check
      CHECK ((op_status IS NULL) OR (op_status = ANY (ARRAY['started'::text, 'paused'::text, 'done'::text]))),
    CONSTRAINT harness_plans_workspace_nonempty CHECK ((workspace_id <> ''::text))
);

DO $baseline_guard$ BEGIN
  ALTER TABLE ONLY harness_shared.harness_plans
    ADD CONSTRAINT harness_plans_pkey PRIMARY KEY (workspace_id, harness_slug, plan_slug);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $baseline_guard$;

COMMENT ON TABLE harness_shared.harness_plans IS
  'PG-canonical plan storage (plans-pg-canonical-migration-2026-06-03). content TEXT is the canonical markdown blob (D-002); frontmatter + op_* columns are a derived index. Folds harness_plan_status (mig 086). Federates as papercup-harness content over peer-log (D-004). Replaces the filesystem-canonical apps/operator/docs/plans/*.md.';

-- Search + lookup indexes. The PK (workspace_id, harness_slug, plan_slug) already
-- serves list-by-(workspace,harness) via its left prefix.
CREATE INDEX IF NOT EXISTS harness_plans_search_idx
  ON harness_shared.harness_plans USING gin (_search);

CREATE INDEX IF NOT EXISTS harness_plans_started_idx
  ON harness_shared.harness_plans USING btree (workspace_id, harness_slug, op_status)
  WHERE (op_status = 'started'::text);

-- Auto-bump updated_at on every write (the app also bumps version explicitly
-- via CAS; this keeps updated_at honest even for paths that forget).
CREATE OR REPLACE FUNCTION harness_shared.set_harness_plans_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS harness_plans_updated_at_trg ON harness_shared.harness_plans;
CREATE TRIGGER harness_plans_updated_at_trg
  BEFORE UPDATE ON harness_shared.harness_plans
  FOR EACH ROW EXECUTE FUNCTION harness_shared.set_harness_plans_updated_at();

-- RLS: workspace isolation (mirrors harness_features_consolidated / harness_plan_status).
-- harness_admin (the operator's admin DSN) has BYPASSRLS (mig 016) so backfills +
-- cross-harness reads are unfiltered; harness_app connections are scoped by app.workspace_id.
ALTER TABLE harness_shared.harness_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS harness_plans_workspace_isolation ON harness_shared.harness_plans;
CREATE POLICY harness_plans_workspace_isolation ON harness_shared.harness_plans
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Grants. Migration 109's ALTER DEFAULT PRIVILEGES already covers tables created
-- by harness_admin, but grant explicitly too (idempotent; tolerate a missing
-- harness_zero on test rigs).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_plans TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.harness_plans TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMIT;
