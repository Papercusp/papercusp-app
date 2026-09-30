\set ON_ERROR_STOP on
BEGIN;

-- Phase 2 of un-hardcode: PG-canonical storage for filesystem-only state.
-- Vertical 1: brainstorm artifacts. The .harness/brainstorm.{md,canvas.json,
-- mindmap.json} files become a derived mirror; the canonical store is here.

CREATE TABLE IF NOT EXISTS harness_shared.harness_brainstorm (
  harness_slug TEXT NOT NULL,
  phase        TEXT NOT NULL DEFAULT 'staging',
  content      TEXT NOT NULL DEFAULT '',
  canvas       JSONB,
  mindmap      JSONB,
  updated_at   BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (harness_slug, phase)
);
CREATE INDEX IF NOT EXISTS harness_brainstorm_workspace_idx
  ON harness_shared.harness_brainstorm (workspace_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_brainstorm TO harness_app, harness_admin;
GRANT SELECT ON harness_shared.harness_brainstorm TO harness_zero;

COMMENT ON TABLE harness_shared.harness_brainstorm IS
  'Canonical brainstorm artifacts (Migration 033, Phase 2). FS at .harness/brainstorm.{md,canvas.json,mindmap.json} is now a derived mirror.';

COMMIT;
