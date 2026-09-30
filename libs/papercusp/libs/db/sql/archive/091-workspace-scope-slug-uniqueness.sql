-- 091 — workspace-scope the slug uniqueness on token_index + projects.
--
-- Part of harnesses-across-workspaces (plan 2026-05-31, decision D-2). Today a
-- harness slug / system-principal slug must be globally unique, which blocks a
-- harness (or the operator/oracle system principal) from existing in more than
-- one workspace — and is the exact `token_index_harness_slug_key` duplicate-key
-- error hit when provisioning the operator principal in a second workspace.
--
-- This loosens the uniqueness to composite (workspace_id, slug). It is a SAFE
-- widening: the composite still forbids duplicates WITHIN a workspace, and any
-- existing row (one per slug today) trivially satisfies it — no data can
-- violate the new key. Idempotent (guarded) so the boot migration-runner can
-- re-apply harmlessly.
--
-- Note: slug→row lookups that assume a single global match (e.g. resolve a
-- harness by slug without a workspace) remain correct until a slug is actually
-- registered in a second workspace; making those lookups workspace-aware is
-- Phase 2 of the plan. This migration only removes the hard blocker.

-- token_index: drop global UNIQUE(harness_slug) → UNIQUE(workspace_id, harness_slug)
ALTER TABLE harness_shared.token_index
  DROP CONSTRAINT IF EXISTS token_index_harness_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS token_index_ws_harness_slug_idx
  ON harness_shared.token_index(workspace_id, harness_slug);

-- projects: drop global UNIQUE(slug) → UNIQUE(workspace_id, slug)
DROP INDEX IF EXISTS harness_shared.projects_slug_idx;
CREATE UNIQUE INDEX IF NOT EXISTS projects_ws_slug_idx
  ON harness_shared.projects(workspace_id, slug);
