\set ON_ERROR_STOP on
BEGIN;

-- Migration 041 — operator-side mirror of ~/autonomous-harness/identity/*.md.
--
-- The identity files are cross-mission append-only memory per role (see
-- /docs/architecture/memory.md L4). The curator writes them via LLM tool
-- calls (no programmatic writer in our code) and the orchestrator's
-- prompt-build.ts:87 reads them from disk per-role. The file remains
-- canonical for that subprocess-reads contract; this PG mirror is for
-- the operator UI's IdentityPanel and any future Zero subscribers, so
-- they don't have to readdirSync on every request.
--
-- A small fs-watcher in apps/operator (harness-fs-watcher's identity
-- mirror) keeps this table fresh.

CREATE TABLE IF NOT EXISTS harness_shared.identity_files (
  role         TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  bytes        INTEGER NOT NULL DEFAULT 0,
  mtime_ms     BIGINT NOT NULL DEFAULT 0,
  updated_at   BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (role)
);

CREATE INDEX IF NOT EXISTS identity_files_workspace_idx
  ON harness_shared.identity_files (workspace_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.identity_files TO harness_app, harness_admin;
GRANT SELECT ON harness_shared.identity_files TO harness_zero;

COMMENT ON TABLE harness_shared.identity_files IS
  'Mirror of ~/autonomous-harness/identity/<role>.md, populated by the operator fs-watcher. Files remain canonical (orchestrator subprocess reads them at prompt-build time).';

COMMIT;
