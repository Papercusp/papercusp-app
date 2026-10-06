-- 1344-completion-history-search-memo.sql — WI-10005560
--
-- The completion-settlement reconciler keeps, per (repository root, close-time HEAD,
-- path, close-time blob) pair, an EXACT verdict over a commit range: "no commit in
-- from..W has this blob at this path" (searched_through = W) or "the per-pair search
-- over from..W found it" (found_through = W). Until now that memo lived only in the
-- bg-host process, so every restart (about every 33 min) dropped it and the next
-- rotation re-searched every pair over its whole range: 6,440 per-pair `git log`
-- execs in the first 10 min after a boot vs 1,024 warm (measured 2026-10-02).
--
-- Each row is an exact statement about the commit DAG, so it holds in any process
-- that can see those commits, and last-writer-wins is safe: an older W is still a
-- true (just less advanced) bound. A row whose W no longer resolves makes the next
-- search fail, and the reader then falls back to the exact per-pair search.
--
-- FORWARD-COMPAT: additive only (new table). The currently deployed release never
-- reads or writes it; a release without the reader simply leaves the table unused.

CREATE TABLE IF NOT EXISTS harness_shared.completion_history_search_memo (
  workspace_id        text        NOT NULL,
  -- The pair key, as the reader builds it.
  repository_root     text        NOT NULL CHECK (length(repository_root) BETWEEN 1 AND 4096),
  from_head_sha       text        NOT NULL CHECK (from_head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  path                text        NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
  blob_sha            text        NOT NULL CHECK (blob_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  -- Where the pair resolved at its close-time HEAD (a submodule root/commit/path when nested).
  resolved_root       text        NOT NULL CHECK (length(resolved_root) BETWEEN 1 AND 4096),
  resolved_from_sha   text        NOT NULL CHECK (resolved_from_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  resolved_path       text        NOT NULL CHECK (length(resolved_path) BETWEEN 1 AND 4096),
  searched_through    text        CHECK (searched_through ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  found_through       text        CHECK (found_through ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, repository_root, from_head_sha, path, blob_sha),
  CONSTRAINT completion_history_search_memo_one_verdict CHECK (
    (searched_through IS NULL) <> (found_through IS NULL)
  )
);

-- Hydration reads the most recently touched rows first; retention prunes by age.
CREATE INDEX IF NOT EXISTS completion_history_search_memo_recent_idx
  ON harness_shared.completion_history_search_memo (workspace_id, updated_at DESC);

ALTER TABLE harness_shared.completion_history_search_memo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS completion_history_search_memo_workspace_isolation
  ON harness_shared.completion_history_search_memo;
CREATE POLICY completion_history_search_memo_workspace_isolation
  ON harness_shared.completion_history_search_memo FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.completion_history_search_memo TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.completion_history_search_memo IS
  'Completion-settlement per-(path, close-time blob) history search verdicts, kept across bg-host restarts (WI-10005560). Each row is an exact statement over a commit range; rows untouched for 14 days are pruned by the reader.';
