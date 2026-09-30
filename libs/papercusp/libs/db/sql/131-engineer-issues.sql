-- Migration 131 — engineer_issues: the agent-facing issue surface.
--
-- Plan: engineer-issues-2026-06-03 (Phase 1). A SEPARATE table from the validator
-- pipeline's harness_issues_consolidated (D-001): engineer/SU-discovered issues are
-- ad-hoc, often featureless, claimable, lifecycle-managed, and ride the coordination
-- substrate — Subscribable / Taggable / Threadable / Linkable via the coord_* tables
-- (migration 123); Claimable (`assignee`) + Lifecycle (`state`) are interface-only
-- capabilities whose scalars live here on the object's own table (capabilities/types.ts).
--
-- Shared shape with the pipeline (D-001): `severity` uses the SAME canonical enum as
-- harness_issues_consolidated (app/harness/issues/types.ts IssueSeverity — migration 130).
-- `source` is engineer|su (this surface is human/SU-authored, not validator-authored).
-- `state` is the Lifecycle enum (open|resolved|closed). Issue ids are 'EI-<n>'
-- (workspace-scoped), a distinct namespace from the pipeline's 'I-NNNN' so both share
-- the unified ObjectRef kind 'issue' for topic fan-out without a ref collision.
--
-- Federation (D-009): the columns origin/author_pubkey are present so a harness-scoped
-- row can later federate via the peer-log (the deferred upgrade); v1 is WORKSPACE-LOCAL
-- (delivery via the synchronous local fan-out, fanoutForObject) — classified
-- workspace-owned/sync:none in table-registry.ts.
--
-- NO RLS (matches the coord_* family): the issues:* tools connect via the org/admin
-- (BYPASSRLS) handle and filter by workspace_id in-query; SU uses workspace_id='*' as a
-- cross-workspace scope, which a row-isolation policy would break.
--
-- Idempotent; composes onto 000-baseline.sql for fresh/embedded-pg boots; applies on :5432.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.engineer_issues (
    workspace_id text DEFAULT 'default'::text NOT NULL,
    issue_id text NOT NULL,                         -- 'EI-<n>', workspace-scoped
    scope text DEFAULT 'operator'::text NOT NULL,   -- 'operator' | 'harness:<slug>'
    title text NOT NULL,
    body text DEFAULT ''::text NOT NULL,            -- markdown description / details
    severity text DEFAULT 'minor'::text NOT NULL,   -- shared IssueSeverity enum
    source text DEFAULT 'engineer'::text NOT NULL,  -- engineer | su
    state text DEFAULT 'open'::text NOT NULL,       -- Lifecycle: open | resolved | closed
    assignee text,                                  -- Claimable scalar (owner_id), NULL = unclaimed
    found_during text,                              -- optional context (a feature/plan ref)
    linked_feature_id text,                         -- promote-to-feature target (F-FIX-*)
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,

    -- Federation (deferred D-009; v1 local). Capture-ready columns, mirroring
    -- harness_issues_consolidated, so a later migration can attach the peer-log
    -- projection without a table change.
    author_pubkey text,
    origin text DEFAULT 'local'::text NOT NULL,

    _search tsvector GENERATED ALWAYS AS (
      (setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char")
       || setweight(to_tsvector('english'::regconfig, COALESCE(body, ''::text)), 'B'::"char"))
    ) STORED,

    CONSTRAINT engineer_issues_pkey PRIMARY KEY (workspace_id, issue_id),
    CONSTRAINT engineer_issues_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'major'::text, 'minor'::text, 'nit'::text]))),
    CONSTRAINT engineer_issues_source_check CHECK ((source = ANY (ARRAY['engineer'::text, 'su'::text]))),
    CONSTRAINT engineer_issues_state_check CHECK ((state = ANY (ARRAY['open'::text, 'resolved'::text, 'closed'::text]))),
    CONSTRAINT engineer_issues_scope_nonempty CHECK ((scope <> ''::text)),
    CONSTRAINT engineer_issues_workspace_nonempty CHECK ((workspace_id <> ''::text))
);

COMMENT ON TABLE harness_shared.engineer_issues IS
  'Agent-facing engineer/SU issue surface (engineer-issues-2026-06-03 D-001). Separate from the validator pipeline''s harness_issues_consolidated. Rides the coordination substrate (coord_* tables) for Subscribable/Taggable/Threadable/Linkable; Claimable=assignee + Lifecycle=state stored here. severity shares the pipeline IssueSeverity enum; source engineer|su; ObjectRef kind ''issue'', id ''EI-<n>''. Workspace-local in v1 (federation deferred, D-009).';

CREATE INDEX IF NOT EXISTS engineer_issues_scope_state_idx
  ON harness_shared.engineer_issues USING btree (workspace_id, scope, state);
CREATE INDEX IF NOT EXISTS engineer_issues_state_idx
  ON harness_shared.engineer_issues USING btree (workspace_id, state);
CREATE INDEX IF NOT EXISTS engineer_issues_assignee_idx
  ON harness_shared.engineer_issues USING btree (workspace_id, assignee) WHERE (assignee IS NOT NULL);
CREATE INDEX IF NOT EXISTS engineer_issues_feature_idx
  ON harness_shared.engineer_issues USING btree (linked_feature_id) WHERE (linked_feature_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS engineer_issues_search_idx
  ON harness_shared.engineer_issues USING gin (_search);

CREATE OR REPLACE FUNCTION harness_shared.set_engineer_issues_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS engineer_issues_updated_at_trg ON harness_shared.engineer_issues;
CREATE TRIGGER engineer_issues_updated_at_trg
  BEFORE UPDATE ON harness_shared.engineer_issues
  FOR EACH ROW EXECUTE FUNCTION harness_shared.set_engineer_issues_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.engineer_issues TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.engineer_issues TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMIT;
