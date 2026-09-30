-- 982-session-task-work-item-links.sql — pui-agent-context-cockpit-2026-08-26 P-003.
--
-- Typed M:N bridge between a chat session's canonical tasks and durable work
-- items. A task may relate to any number of work-items, but exactly one `for`
-- edge may carry checkpoint synchronization. Completion deliberately remains
-- independent on both sides.
-- FORWARD-COMPAT: This migration creates the table and its uniqueness contracts together; the deployed release has no reference to the new table, so it cannot depend on a pre-existing non-partial arbiter.
--
-- No top-level BEGIN/COMMIT: the migration runner wraps each file.

CREATE TABLE IF NOT EXISTS harness_shared.session_task_work_item_links (
  workspace_id      TEXT        NOT NULL,
  session_id        TEXT        NOT NULL,
  task_id           TEXT        NOT NULL,
  relation          TEXT        NOT NULL CHECK (relation IN ('for', 'relates')),
  work_item_harness TEXT        NOT NULL DEFAULT '',
  work_item_id      TEXT        NOT NULL CHECK (length(btrim(work_item_id)) BETWEEN 1 AND 240),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (
    workspace_id,
    session_id,
    task_id,
    relation,
    work_item_harness,
    work_item_id
  ),
  CONSTRAINT session_task_work_item_links_task_fk
    FOREIGN KEY (workspace_id, session_id, task_id)
    REFERENCES harness_shared.session_tasks (workspace_id, session_id, task_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS session_task_work_item_links_one_for_uq
  ON harness_shared.session_task_work_item_links (workspace_id, session_id, task_id)
  WHERE relation = 'for';

CREATE INDEX IF NOT EXISTS session_task_work_item_links_reverse_idx
  ON harness_shared.session_task_work_item_links
    (workspace_id, work_item_harness, work_item_id, relation, session_id, task_id);

COMMENT ON TABLE harness_shared.session_task_work_item_links IS
  'M:N typed task-to-work-item edges. `for` is the single checkpoint-sync target; `relates` is informational.';

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.session_task_work_item_links TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.session_task_work_item_links TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.session_task_work_item_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_task_work_item_links_workspace_isolation
  ON harness_shared.session_task_work_item_links;
CREATE POLICY session_task_work_item_links_workspace_isolation
  ON harness_shared.session_task_work_item_links
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
