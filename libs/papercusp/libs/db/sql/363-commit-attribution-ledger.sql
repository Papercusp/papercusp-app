-- 363-commit-attribution-ledger.sql
--
-- deterministic-commit-workitem-attribution-2026-06-22 (P-001 + P-004).
--
-- Two tables for DETERMINISTIC, agent-free commit -> work-item attribution (D-001:
-- derived server-side from data agents already emit; agents never commit, ~zero token
-- cost). Both are written by SERVER code, never by an agent tool call (D-006).
--
--  * edit_attribution_ledger (P-001) — the CAPTURE spine. One row per file edit, written
--    by the locks:acquire handler when a write lock is granted, joining the holder's
--    already-claimed lane (work-item + plan + intent). Captured at EDIT time (not derived
--    from live presence at commit time, D-002) so attribution SURVIVES the agent's session
--    ending before the ~10-min git-sync tick.
--
--  * git_sync_commit_attribution (P-004) — the durable LINK. After git-sync makes a
--    per-agent commit, one row per (commit_sha, file, work_item) — a multi-agent file
--    honestly yields multiple rows. Powers the doc-drift "which work-item changed this
--    code?" join (P-005) and the merge-resolver authorship context (P-006).
--
-- Per-FILE, set-valued; never per-hunk (D-003). No RLS (mirrors 260-decision-ledger /
-- 251-fleet-ekg): the writers use the admin pool and every reader scopes by workspace_id
-- explicitly.

-- ── P-001: the edit-time attribution ledger ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.edit_attribution_ledger (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id    text NOT NULL,
    harness_slug    text NOT NULL,
    repo            text NOT NULL,
    file            text NOT NULL,
    agent_id        text NOT NULL,
    session_id      text,
    contributor     text,
    work_item_id    text,
    plan_slug       text,
    intent          text,
    ts              timestamptz NOT NULL DEFAULT now()
);
-- NOTE: this is the AS-APPLIED schema. Migration 364 reshapes it to the repo_root-keyed
-- form the code uses (harness_slug not 1:1 with a repo; the lock is repo-root-keyed,
-- D-015). 363 applied before that was understood; editing it here is inert on the live
-- DB (the runner skips applied files by name — see the editing-applied-migration-is-inert
-- runbook), so the reshape lives in 364 and this file stays faithful to what 363 applied.

-- per-file lookup + the git-sync window scan (rows since the last commit for a repo).
CREATE INDEX IF NOT EXISTS edit_attribution_ledger_repo_file_idx
  ON harness_shared.edit_attribution_ledger (workspace_id, harness_slug, repo, file, ts DESC);
-- "what did WI-N touch?" reverse lookup.
CREATE INDEX IF NOT EXISTS edit_attribution_ledger_work_item_idx
  ON harness_shared.edit_attribution_ledger (work_item_id, ts DESC)
  WHERE work_item_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.edit_attribution_ledger TO harness_app;
GRANT USAGE, SELECT
  ON SEQUENCE harness_shared.edit_attribution_ledger_id_seq TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.edit_attribution_ledger TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

-- ── P-004: the durable commit -> work-item link ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.git_sync_commit_attribution (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id    text NOT NULL,
    harness_slug    text NOT NULL,
    repo            text NOT NULL,
    commit_sha      text NOT NULL,
    file            text NOT NULL,
    agent_id        text,
    session_id      text,
    contributor     text,
    work_item_id    text,
    plan_slug       text,
    ts              timestamptz NOT NULL DEFAULT now()
);

-- doc-drift reverse lookup (file changed -> which work-item) + per-file history.
CREATE INDEX IF NOT EXISTS git_sync_commit_attr_repo_file_idx
  ON harness_shared.git_sync_commit_attribution (workspace_id, harness_slug, repo, file, ts DESC);
-- "what shipped under WI-N?"
CREATE INDEX IF NOT EXISTS git_sync_commit_attr_work_item_idx
  ON harness_shared.git_sync_commit_attribution (work_item_id, ts DESC)
  WHERE work_item_id IS NOT NULL;
-- all files/work-items in one commit (the merge-resolver authorship lookup).
CREATE INDEX IF NOT EXISTS git_sync_commit_attr_sha_idx
  ON harness_shared.git_sync_commit_attribution (commit_sha);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.git_sync_commit_attribution TO harness_app;
GRANT USAGE, SELECT
  ON SEQUENCE harness_shared.git_sync_commit_attribution_id_seq TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.git_sync_commit_attribution TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
