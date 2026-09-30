-- 113-reconcile-stale-token-index-slug-constraint.sql
--
-- Reconcile a SCHEMA DRIFT on long-lived databases: migration 091
-- (workspace-scope-slug-uniqueness, since squashed into 000-baseline) replaced
-- the GLOBAL UNIQUE(harness_slug) on token_index — and UNIQUE(slug) on projects —
-- with workspace-scoped uniqueness. 000-baseline ships only the workspace-scoped
-- form, so a FRESH database is already correct. But databases provisioned before
-- 091 actually applied still carry the old global `token_index_harness_slug_key`
-- constraint, which makes provisioning a system principal (or any harness) whose
-- slug already exists in ANOTHER workspace fail with
--   duplicate key value violates unique constraint "token_index_harness_slug_key"
-- and leaves the operator unable to (re)provision — observed on the dev box.
--
-- Fully idempotent (IF EXISTS / IF NOT EXISTS): a no-op on any DB already on the
-- workspace-scoped form, a reconciliation on the drifted ones. Relaxes (never
-- tightens) uniqueness, so it cannot conflict with existing rows.

-- token_index: drop the stale global UNIQUE(harness_slug); keep workspace-scoped.
ALTER TABLE harness_shared.token_index
  DROP CONSTRAINT IF EXISTS token_index_harness_slug_key;
DROP INDEX IF EXISTS harness_shared.token_index_harness_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS token_index_ws_harness_slug_idx
  ON harness_shared.token_index(workspace_id, harness_slug);

-- projects: same drift, same reconciliation.
ALTER TABLE harness_shared.projects
  DROP CONSTRAINT IF EXISTS projects_slug_key;
DROP INDEX IF EXISTS harness_shared.projects_slug_idx;
CREATE UNIQUE INDEX IF NOT EXISTS projects_ws_slug_idx
  ON harness_shared.projects(workspace_id, slug);
