-- Migration 046 — tool_invocations + harness_chunk_plans.spawned_by_spawn_id.
--
-- Plugin MCP host foundation, PR 5. Two purposes from one table:
--
--   1. Quota enforcement at MCP request time. The plugin-tool dispatcher
--      counts (workspace × tool × role × window_key) where window_key is
--      "chunk:<id>" for workers and "run:<id>" for non-workers; rejects
--      with `quota-exceeded` when count >= the tool's manifest-declared
--      rolesQuota for that role.
--
--   2. Phase 6 telemetry. The Intel-tab "Pack" / "Graph" / "Diff" sub-tabs
--      query this table to show which agent invoked which tool when, on
--      what feature, with what duration and outcome. status='ok' rows
--      are also the rows quota counts against.
--
-- Phase 9 forward-looking: parent_spawn_id captures the spawn-of-spawn
-- lineage when an agent calls orchestrator.spawn (Phase 9). Today it's
-- always null on real rows; Phase 9 lights it up without schema change.
-- Same for harness_chunk_plans.spawned_by_spawn_id below.
--
-- Idempotent + non-destructive — adds tables/columns only.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.tool_invocations (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  harness_slug    TEXT NOT NULL,
  plugin_name     TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  role            TEXT NOT NULL,
  feature_id      TEXT NULL,
  chunk_id        TEXT NULL,
  run_id          TEXT NULL,
  spawn_id        TEXT NOT NULL,
  parent_spawn_id TEXT NULL,                 -- Phase 9 lineage
  window_key      TEXT NOT NULL,             -- 'chunk:<id>' for workers, 'run:<id>' otherwise
  invoked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms     INT NULL,
  status          TEXT NOT NULL,             -- 'ok' | 'error' | 'quota-exceeded' | 'role-not-allowed' | 'timeout'
  output_ref      TEXT NULL,                 -- path to .harness/scratch/<...> for disk-handoff outputs
  output_size     BIGINT NULL,
  error_message   TEXT NULL
);

-- Quota lookup index: matches the dispatch-side query exactly.
-- Partial index on status='ok' because only successful calls count
-- against quota — quota-exceeded / role-not-allowed / timeout don't
-- consume a slot.
CREATE INDEX IF NOT EXISTS tool_invocations_quota_idx
  ON harness_shared.tool_invocations (workspace_id, tool_name, role, window_key)
  WHERE status = 'ok';

-- Telemetry / Intel-tab feed: most-recent-first per harness.
CREATE INDEX IF NOT EXISTS tool_invocations_telemetry_idx
  ON harness_shared.tool_invocations (workspace_id, harness_slug, invoked_at DESC);

-- RLS: same workspace-scoping as every other harness_shared table.
ALTER TABLE harness_shared.tool_invocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tool_invocations_workspace_isolation ON harness_shared.tool_invocations;
CREATE POLICY tool_invocations_workspace_isolation
  ON harness_shared.tool_invocations
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT
  ON harness_shared.tool_invocations TO harness_app;
GRANT USAGE, SELECT
  ON SEQUENCE harness_shared.tool_invocations_id_seq TO harness_app;
GRANT ALL
  ON harness_shared.tool_invocations TO harness_admin;
GRANT ALL
  ON SEQUENCE harness_shared.tool_invocations_id_seq TO harness_admin;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
    GRANT SELECT ON harness_shared.tool_invocations TO harness_zero;
    GRANT SELECT ON SEQUENCE harness_shared.tool_invocations_id_seq TO harness_zero;
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'harness_shared_pub') THEN
    BEGIN
      ALTER PUBLICATION harness_shared_pub
        ADD TABLE harness_shared.tool_invocations;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END IF;
END$$;


-- ── Phase 9 forward-looking column on harness_chunk_plans ────────────
--
-- When an agent calls orchestrator.spawn(role: 'worker', feature: ...)
-- (Phase 9), the spawned worker registers its chunk-of-work in this
-- table same as orchestrator-launched workers. spawned_by_spawn_id
-- lets the chunk planner detect "this feature already has an active
-- worker" without double-launching, and tool_invocations.parent_spawn_id
-- references the same spawn ID so the audit chain is consistent.

ALTER TABLE harness_shared.harness_chunk_plans
  ADD COLUMN IF NOT EXISTS spawned_by_spawn_id TEXT NULL;

CREATE INDEX IF NOT EXISTS chunk_plans_by_spawned_by
  ON harness_shared.harness_chunk_plans (workspace_id, harness_slug, spawned_by_spawn_id)
  WHERE spawned_by_spawn_id IS NOT NULL;

COMMIT;
