-- 364-edit-attribution-ledger-repo-root.sql
--
-- deterministic-commit-workitem-attribution-2026-06-22 (P-001, fixup of 363).
--
-- Reshape harness_shared.edit_attribution_ledger to the repo_root-keyed form the capture
-- code uses. 363 created it harness_slug/repo-keyed + NOT NULL before we understood the
-- file-lock is workspace/harness-INDEPENDENT (keyed by the physical repo root, D-015):
--   * harness_slug + work_item are NOT 1:1 with a repo, so they are joined from the
--     holder's claim and must be NULLABLE (NULL = an honest unattributed edit, D-003);
--   * the reliable key git-sync reads the window back by is the repo ROOT.
-- 363 already applied with the old shape on the live box (editing 363 in place is inert —
-- the runner skips applied files by name), so the reshape lives here.
--
-- Idempotent: safe whether the table has the old 363 shape (live) or a fresh install where
-- each step no-ops.

ALTER TABLE harness_shared.edit_attribution_ledger
  ADD COLUMN IF NOT EXISTS repo_root text;

-- harness_slug + work_item now come from the claim (nullable); workspace_id + the old
-- `repo` scope are recorded-if-known, not required.
ALTER TABLE harness_shared.edit_attribution_ledger ALTER COLUMN harness_slug DROP NOT NULL;
ALTER TABLE harness_shared.edit_attribution_ledger ALTER COLUMN workspace_id DROP NOT NULL;
DO $r$ BEGIN
  ALTER TABLE harness_shared.edit_attribution_ledger ALTER COLUMN repo DROP NOT NULL;
EXCEPTION WHEN undefined_column THEN NULL;
END $r$;

-- swap the old (workspace, harness, repo, file) index for the repo_root window-scan index
-- git-sync uses (rows since the last commit for a repo root). Same name, new definition.
DROP INDEX IF EXISTS harness_shared.edit_attribution_ledger_repo_file_idx;
CREATE INDEX IF NOT EXISTS edit_attribution_ledger_repo_file_idx
  ON harness_shared.edit_attribution_ledger (repo_root, file, ts DESC);
