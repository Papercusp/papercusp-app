\set ON_ERROR_STOP on
BEGIN;

-- Phase 2 vertical 3 (Migration 035): generic text artifact store keyed
-- (harness_slug, path). Used for memory/{raw,summary,MEMORY}.md,
-- supervisor-notes.md, issues.md, and any future per-file artifact that
-- doesn't deserve its own column. The on-disk files become best-effort
-- mirrors written on each PUT.
--
-- Structured artifacts (features, issues, agent_runs, snapshots, project
-- files, brainstorm) keep their own typed tables; this is for free-form
-- text that the operator panels read/write as opaque content.

CREATE TABLE IF NOT EXISTS harness_shared.harness_text_artifacts (
  harness_slug TEXT NOT NULL,
  -- Relative path under the harness, e.g. 'memory/raw.md',
  -- 'supervisor-notes.md', 'issues.md'. Keeps the on-disk layout 1:1
  -- with the PG row so the FS mirror is trivial to construct.
  rel_path     TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  updated_at   BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (harness_slug, rel_path)
);
CREATE INDEX IF NOT EXISTS hta_workspace_idx
  ON harness_shared.harness_text_artifacts (workspace_id);
CREATE INDEX IF NOT EXISTS hta_updated_idx
  ON harness_shared.harness_text_artifacts (harness_slug, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_text_artifacts TO harness_app, harness_admin;
GRANT SELECT ON harness_shared.harness_text_artifacts TO harness_zero;

COMMENT ON TABLE harness_shared.harness_text_artifacts IS
  'Generic text artifact store, keyed (harness_slug, rel_path). Migration 035, Phase 2. FS files at <harness_dir>/<rel_path> are derived mirrors.';

COMMIT;
