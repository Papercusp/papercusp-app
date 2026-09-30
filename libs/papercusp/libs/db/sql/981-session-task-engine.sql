-- 981-session-task-engine.sql — pui-agent-context-cockpit-2026-08-26 P-001.
--
-- Canonical ordered task state for the operator-owned chat loop. Models write
-- compact operations through tasks:ops; the harness stores the full list here.
-- One row per task keeps the state queryable and lets the generic change-notify
-- trigger drive the same PG -> SSE invalidation path as the rest of the UI.
--
-- No top-level BEGIN/COMMIT: the migration runner wraps each file.

CREATE TABLE IF NOT EXISTS harness_shared.session_tasks (
  workspace_id     TEXT        NOT NULL,
  session_id       TEXT        NOT NULL,
  task_id          TEXT        NOT NULL,
  position         INTEGER     NOT NULL CHECK (position >= 0),
  content          TEXT        NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 4000),
  active_form      TEXT        NOT NULL CHECK (length(btrim(active_form)) BETWEEN 1 AND 500),
  status           TEXT        NOT NULL CHECK (
    status IN ('pending', 'in_progress', 'blocked', 'completed', 'dropped')
  ),
  blocker_ref      TEXT,
  last_explanation TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_id, task_id),
  CONSTRAINT session_tasks_blocker_shape CHECK (
    (status = 'blocked' AND blocker_ref IS NOT NULL AND length(btrim(blocker_ref)) BETWEEN 1 AND 2000)
    OR (status <> 'blocked' AND blocker_ref IS NULL)
  ),
  CONSTRAINT session_tasks_explanation_size CHECK (
    last_explanation IS NULL OR length(btrim(last_explanation)) BETWEEN 1 AND 2000
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS session_tasks_position_uq
  ON harness_shared.session_tasks (workspace_id, session_id, position);

-- The store reducer enforces this too; the partial unique index is the
-- structural guarantee under concurrent or non-tool writes.
-- FORWARD-COMPAT: session_tasks is created by this same migration, so the
-- currently deployed release cannot have an ON CONFLICT writer that depends
-- on a different un-predicated index over these columns.
CREATE UNIQUE INDEX IF NOT EXISTS session_tasks_one_in_progress_uq
  ON harness_shared.session_tasks (workspace_id, session_id)
  WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS session_tasks_updated_idx
  ON harness_shared.session_tasks (workspace_id, session_id, updated_at DESC);

COMMENT ON TABLE harness_shared.session_tasks IS
  'Canonical ordered tasks per owned-loop/chat session. Mutated through tasks:ops; at most one task may be in_progress.';

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.session_tasks TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.session_tasks TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.session_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_tasks_workspace_isolation ON harness_shared.session_tasks;
CREATE POLICY session_tasks_workspace_isolation
  ON harness_shared.session_tasks
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Generic PG change event -> sync/SSE invalidation. This makes task writes
-- observable outside the tool call itself (including direct/federated writes).
CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.session_tasks
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
