-- 009-workspace-scoping.sql
--
-- Phase A of the Agent MCP plan: add workspace_id as a Postgres-enforced
-- scoping key on every harness_shared.* table that spans workspaces.
--
-- This migration is ADDITIVE only:
--   1. Adds workspace_id columns with empty-string default.
--   2. Creates indexes on workspace_id.
--   3. Adds new principal tables (system_principals, pi_sessions).
--   4. Extends token_index.kind values (no DDL change; values are TEXT).
--
-- Row-level security and the column NOT NULL/CHECK constraints land in a
-- FOLLOW-UP migration (010-workspace-scoping-rls.sql) AFTER the backfill
-- script (libs/db/scripts/backfill-workspace-id.ts) has populated real
-- workspace_id values. Splitting the two halves lets operators run the
-- column add + backfill with the existing reads still functional, then
-- enable enforcement once the data is correct.
--
-- Idempotent — safe to re-run.

-- ────────────────────────────────────────────────────────────────────────
-- harness_shared.* — add workspace_id to every workspace-scoped table.
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE harness_shared.projects
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS projects_workspace_idx
  ON harness_shared.projects(workspace_id);

ALTER TABLE harness_shared.audit_log
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS audit_workspace_idx
  ON harness_shared.audit_log(workspace_id);

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS hfc_workspace_idx
  ON harness_shared.harness_features_consolidated(workspace_id);

ALTER TABLE harness_shared.plugin_enables
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS plugin_enables_workspace_idx
  ON harness_shared.plugin_enables(workspace_id);

ALTER TABLE harness_shared.plugin_configs
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS plugin_configs_workspace_idx
  ON harness_shared.plugin_configs(workspace_id);

-- 005-goals-events-routines.sql tables.
ALTER TABLE harness_shared.goals
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS goals_workspace_idx
  ON harness_shared.goals(workspace_id);

ALTER TABLE harness_shared.pending_events
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS pending_events_workspace_idx
  ON harness_shared.pending_events(workspace_id);

ALTER TABLE harness_shared.routines
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS routines_workspace_idx
  ON harness_shared.routines(workspace_id);

-- 007-project-specs.sql.
ALTER TABLE harness_shared.project_spec_revisions
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS project_spec_revisions_workspace_idx
  ON harness_shared.project_spec_revisions(workspace_id);

-- 008-multi-harness-spawning.sql.
ALTER TABLE harness_shared.token_index
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS token_index_workspace_idx
  ON harness_shared.token_index(workspace_id);

-- ────────────────────────────────────────────────────────────────────────
-- Trigger for harness_features_consolidated must propagate workspace_id
-- from the per-harness table (which derives it from harness's workspace).
--
-- The trigger lives in 001-shared.sql and currently doesn't carry
-- workspace_id; the backfill script repairs the consolidated table after
-- the per-harness tables are tagged. The trigger function is updated in
-- 010 alongside RLS.
-- ────────────────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────────────────
-- New principal tables for the system:<name> and pi:<session-id>
-- principal classes (per the system-and-pi-principals spec amendment).
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS harness_shared.system_principals (
  workspace_id  TEXT NOT NULL,
  name          TEXT NOT NULL,                -- 'operator', 'oracle', ...
  bearer_hash   TEXT NOT NULL,                -- sha256 of bearer
  capabilities  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS system_principals_workspace_idx
  ON harness_shared.system_principals(workspace_id);

CREATE TABLE IF NOT EXISTS harness_shared.pi_sessions (
  workspace_id  TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  bearer_hash   TEXT NOT NULL,
  capabilities  JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, session_id)
);
CREATE INDEX IF NOT EXISTS pi_sessions_workspace_idx
  ON harness_shared.pi_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS pi_sessions_active_idx
  ON harness_shared.pi_sessions(workspace_id, session_id) WHERE ended_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.system_principals
  TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.pi_sessions
  TO harness_app, harness_admin;

-- ────────────────────────────────────────────────────────────────────────
-- token_index extension: add `kind` column if missing. Existing rows are
-- left as-is; the backfill script tags them with kind='harness'.
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE harness_shared.token_index
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'harness';
CREATE INDEX IF NOT EXISTS token_index_kind_idx
  ON harness_shared.token_index(kind);

-- ────────────────────────────────────────────────────────────────────────
-- pending_events_inserted: AFTER INSERT trigger that NOTIFYs concierge
-- listeners. Per the workspace-scoping spec, concierge agents observe
-- (LISTEN) and never UPDATE consumed_at. Trigger payload includes
-- workspace_id so listeners can filter early.
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION harness_shared.notify_pending_events_inserted()
RETURNS TRIGGER AS $$
DECLARE
  payload JSONB;
BEGIN
  payload := jsonb_build_object(
    'id', NEW.id,
    'kind', NEW.kind,
    'target_role', NEW.target_role,
    'workspace_id', NEW.workspace_id,
    'due_at', NEW.due_at,
    'created_at', NEW.created_at
  );
  PERFORM pg_notify('pending_events_inserted', payload::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pending_events_notify_trigger
  ON harness_shared.pending_events;
CREATE TRIGGER pending_events_notify_trigger
  AFTER INSERT ON harness_shared.pending_events
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.notify_pending_events_inserted();
