\set ON_ERROR_STOP on
BEGIN;

-- Phase 2 vertical 2 (Migration 034): SPEC.md, AGENTS.md,
-- validation-contract.md, config.json — PG-canonical project files.
-- The on-disk copies become best-effort mirrors written on each PUT.

CREATE TABLE IF NOT EXISTS harness_shared.harness_project_files (
  harness_slug TEXT NOT NULL,
  spec         TEXT,                    -- SPEC.md (project root)
  agents       TEXT,                    -- AGENTS.md (project root)
  contract     TEXT,                    -- .harness/validation-contract.md
  config       TEXT,                    -- .harness/config.json
  updated_at   BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (harness_slug)
);
CREATE INDEX IF NOT EXISTS harness_project_files_workspace_idx
  ON harness_shared.harness_project_files (workspace_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_project_files TO harness_app, harness_admin;
GRANT SELECT ON harness_shared.harness_project_files TO harness_zero;

COMMENT ON TABLE harness_shared.harness_project_files IS
  'Canonical store for SPEC.md / AGENTS.md / validation-contract.md / config.json (Migration 034, Phase 2). Project-dir files are derived mirrors.';

COMMIT;
