-- Multi-harness spawning + cross-harness coordination support tables.
--
-- See: apps/operator/content/internal-docs/implementation/multi-harness-spawning.mdx
--      apps/operator/app/api/_hono/execute-action.contract.md
--
-- Idempotent — safe to re-run.

-- ── Shared: parent_slug + token index ─────────────────────────────────────

ALTER TABLE harness_shared.projects
  ADD COLUMN IF NOT EXISTS parent_slug TEXT;
CREATE INDEX IF NOT EXISTS projects_parent_idx ON harness_shared.projects(parent_slug);

-- O(1) bearer-token → harness-slug resolution. Maintained alongside the
-- per-harness config_token table (which is the system of record); this
-- mirror exists purely so the executor's auth middleware doesn't need to
-- scan every per-harness schema.
CREATE TABLE IF NOT EXISTS harness_shared.token_index (
  token TEXT PRIMARY KEY,
  harness_slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.token_index TO harness_app, harness_admin;
