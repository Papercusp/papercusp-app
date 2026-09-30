-- Migration 049 — durable record per spawn launched by the
-- orchestrator-spawn plugin (Phase 9).
--
-- v1 of orchestrator-spawn kept state only in a module-level Map. That
-- works while the operator process is alive, but a restart drops every
-- in-flight spawn from poll/list_active/cancel — they become invisible.
--
-- This table mirrors the in-memory record so:
--   - poll/list_active are durable across restarts
--   - the Intel panel's Spawns sub-tab can show a complete launch
--     history, not just "what's in memory right now"
--   - a future PG-watcher process could turn `cancel_requested` into
--     a cross-restart kill signal (v2; not in this migration)
--
-- The orchestrator plugin writes a row on spawn() and updates it in the
-- background promise's then/catch. A startup reaper flips any
-- workspace-local rows still 'running' at boot to 'reaped' (their owning
-- process is gone).
--
-- RLS inherits the same workspace-scoped policy as every other
-- harness_shared table.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
  spawn_id          TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  harness_slug      TEXT NOT NULL,
  parent_spawn_id   TEXT NULL,
  parent_role       TEXT NOT NULL,
  child_role        TEXT NOT NULL,
  feature_id        TEXT NULL,
  chunk_id          TEXT NULL,
  run_id            TEXT NOT NULL,
  -- 'running' | 'done' | 'failed' | 'cancelled' | 'reaped'
  status            TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ NULL,
  duration_ms       BIGINT NULL,
  exit_code         INT NULL,
  output_tail       TEXT NULL,
  error_message     TEXT NULL,
  -- Future v2 hook: a PG-watcher process can SIGTERM the child when this
  -- flips to true even if the operator that launched it has restarted.
  cancel_requested  BOOLEAN NOT NULL DEFAULT false
);

-- Quick lookups by parent for child enumeration + recursive joins.
CREATE INDEX IF NOT EXISTS spawned_agents_parent_idx
  ON harness_shared.spawned_agents (workspace_id, parent_spawn_id);
-- Most-recent-first feed for the Intel panel.
CREATE INDEX IF NOT EXISTS spawned_agents_recent_idx
  ON harness_shared.spawned_agents (workspace_id, harness_slug, started_at DESC);
-- Reaper sweep: WHERE status='running' AND workspace_id = ?
CREATE INDEX IF NOT EXISTS spawned_agents_running_idx
  ON harness_shared.spawned_agents (workspace_id, status)
  WHERE status = 'running';

COMMENT ON TABLE harness_shared.spawned_agents IS
  'Durable mirror of orchestrator-spawn plugin''s in-memory spawn records (Phase 9). '
  'Survives operator restarts so poll/list_active return real history rather than '
  '"not found." Status enum: running|done|failed|cancelled|reaped.';

ALTER TABLE harness_shared.spawned_agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS spawned_agents_workspace_isolation ON harness_shared.spawned_agents;
CREATE POLICY spawned_agents_workspace_isolation
  ON harness_shared.spawned_agents
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE
  ON harness_shared.spawned_agents TO harness_app;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
    GRANT ALL ON harness_shared.spawned_agents TO harness_admin;
  END IF;
END $$;

COMMIT;
