-- Migration 133 — harness_shared.blueprints: the PG projection of the
-- git-canonical Harness Blueprint (`.papercusp/blueprint.yaml`).
--
-- Plan: harness-blueprint-orchestration-2026-06-03 (P-002 / D-006 / D-021).
--
-- The blueprint is GIT-CANONICAL (the file in the harness's repo is the source
-- of truth); this table is the PG CACHE the `deriveNext` interpreter reads,
-- produced by the file-read/parse loader (NOT the Hyperbee CRDT `TableProjection`
-- — D-021). The live-edit "commit → reproject" path (D-007) overwrites the row.
--
-- Cardinality: 1:1 with a harness today (PK = workspace_id + harness_slug). The
-- project-centric 1:N change (D-026 — N blueprint instances per project) is owned
-- by the rethink plan and would add an instance key here later; not landed now.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS before CREATE;
-- GRANTs are repeatable. Composes onto 000-baseline.sql for fresh/embedded-pg
-- boots and applies cleanly on the native :5432 dev box.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.blueprints (
    workspace_id  text NOT NULL,
    harness_slug  text NOT NULL,
    -- The blueprint's own `id` field (e.g. 'coding', 'research'). Distinct from
    -- harness_slug: the slug is the install, the id is the shape it instantiates.
    blueprint_id  text NOT NULL,
    version       text NOT NULL DEFAULT '0.1.0',
    -- The fully-resolved (extends-merged + schema-validated) blueprint. This is
    -- exactly what the interpreter consumes — no merge happens at read time.
    resolved      jsonb NOT NULL,
    -- sha256 of the resolved blueprint — cache key + drift detection (a commit
    -- that doesn't change the resolved shape leaves this unchanged).
    content_hash  text NOT NULL,
    -- The git-canonical source ('.papercusp/blueprint.yaml') + the commit the
    -- projection was taken at (D-006 audit trail; nullable for built-in/seed).
    source_path   text,
    source_commit text,
    projected_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug)
);

COMMENT ON TABLE harness_shared.blueprints IS
    'PG cache of the git-canonical Harness Blueprint (.papercusp/blueprint.yaml). File is source-of-truth; this is the file-read/parse projection the deriveNext interpreter reads (harness-blueprint-orchestration-2026-06-03 D-006/D-021).';

-- Workspace isolation, mirroring the gym control-plane (migration 110). The
-- operator connects as a SUPERUSER role (harness_admin) which bypasses RLS; the
-- policy keeps any non-superuser path workspace-scoped + consistent with the
-- rest of harness_shared.
ALTER TABLE harness_shared.blueprints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS blueprints_workspace_isolation ON harness_shared.blueprints;
CREATE POLICY blueprints_workspace_isolation ON harness_shared.blueprints
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants (the blueprint loader projects under the app role).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.blueprints TO harness_app;
GRANT SELECT ON harness_shared.blueprints TO harness_zero;

COMMIT;
