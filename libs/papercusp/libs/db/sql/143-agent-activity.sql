-- Migration 143 — harness_shared.agent_activity: the cross-CLI worker activity
-- bridge sink.
--
-- Plan: papercusp-worker-integration-2026-06-04 (P0 / D-003). Each worker (a
-- claude / codex / omp session) reports its native tool calls, lifecycle, and
-- TaskCreate/TaskUpdate todos to the `activity:report` MCP tool, which inserts a
-- row here. This is the durable data source for the pui fleet-status view
-- (pui-fleet-status-view-2026-06-04) and the curator (curator-operator-2026-06-04),
-- and the event source the event-reaction system can match on.
--
-- DISTINCT from harness_shared.tool_invocations: that table is the operator's OWN
-- telemetry of every `defineTool` DISPATCH (the MCP server's calls). agent_activity
-- is the worker's NATIVE CLI tool stream (Edit / Write / Bash / Read / apply_patch /
-- Task-todos) — things that never pass through the operator's dispatcher, surfaced
-- only because the per-CLI hooks report them.
--
-- Addressing/trust: `owner_id` is the worker's coordination identity (PAPERCUSP_SID,
-- the same id baked into its MCP `?client=`), NOT a recipient. workspace_id keeps it
-- fleet-scoped like coord. Every write path is loopback-gated + capability-checked at
-- the `activity:report` tool, so there is no RLS here (mirrors tui_intents: the
-- addressing column + loopback bind ARE the boundary).
--
-- Composes onto 000-baseline.sql for fresh/embedded-pg. Idempotent: CREATE … IF NOT
-- EXISTS + CREATE OR REPLACE; repeatable GRANTs (harness_app/harness_zero are created
-- by the embedded-pg boot prereqs before migrations run, per the migration-136/137
-- pattern). Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.agent_activity (
    id            BIGSERIAL PRIMARY KEY,
    -- Fleet scope. Activity is workspace-wide like coord ('*' by default); kept
    -- explicit so a multi-workspace box can filter.
    workspace_id  text        NOT NULL DEFAULT '*',
    -- The reporting worker's coordination identity (PAPERCUSP_SID). This is the
    -- per-pane grouping key for the fleet view, NOT a recipient.
    owner_id      text        NOT NULL,
    -- Which CLI produced it: 'claude' | 'codex' | 'omp' (best-effort; NULL when the
    -- hook couldn't determine it — owner_id is the load-bearing identity).
    agent         text,
    -- The CLI's native session id (claude --session-id / codex rollout uuid / omp
    -- thread), for correlating activity to a resumable session. Optional.
    session_id    text,
    -- The harness the worker is operating in, when known (its cwd's repo). Optional.
    harness_slug  text,
    -- 'tool' (a native tool call) | 'lifecycle' (session start/stop/turn) | 'todos'
    -- (a TaskCreate/TaskUpdate/TodoWrite snapshot).
    kind          text        NOT NULL,
    -- The native tool name (Edit / Write / Bash / Read / apply_patch / shell / …),
    -- for kind='tool'. NULL for lifecycle/todos.
    tool_name     text,
    -- 'pre' (PreToolUse / tool_call) | 'post' (PostToolUse / tool_result). Which side
    -- of the call the report fired on. NULL for non-tool kinds.
    phase         text,
    -- The CLI's per-call id, correlating a pre/post pair. Optional.
    tool_use_id   text,
    -- A short human-facing one-liner the renderer shows verbatim, already derived by
    -- the hook (e.g. '✎ generated.ts', '▶ npm test', '👁 README.md', '⇄ 3 todos').
    summary       text,
    -- 'ok' | 'error' when the report carries an outcome (post phase); else NULL.
    status        text,
    -- Structured, payload-capped detail: for kind='todos' the todo list; for
    -- kind='tool' a small shape ({ file, command, … }). NULL when none.
    detail        jsonb,
    -- The worker's cwd at report time. Optional.
    cwd           text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE harness_shared.agent_activity IS
    'Cross-CLI worker activity bridge sink (papercusp-worker-integration-2026-06-04 D-003): each worker''s native tool calls / lifecycle / todos, reported by the per-CLI hooks via activity:report. The data source for the pui fleet-status view + the curator. owner_id is the worker''s coordination identity (PAPERCUSP_SID), not a recipient. Distinct from tool_invocations (the operator''s own defineTool-dispatch telemetry).';

-- Stream hot-path: a worker's activity in id order (the SSE producer's
-- `owner_id = $1 AND id > $cursor` scan, and the per-pane fleet view).
CREATE INDEX IF NOT EXISTS agent_activity_owner_id_idx
    ON harness_shared.agent_activity USING btree (owner_id, id);

-- Fleet-wide recency scan (the "what is the whole fleet doing" reader + retention).
CREATE INDEX IF NOT EXISTS agent_activity_created_at_idx
    ON harness_shared.agent_activity USING btree (created_at);

-- Per-harness rollup (the fleet view grouped by harness).
CREATE INDEX IF NOT EXISTS agent_activity_harness_idx
    ON harness_shared.agent_activity USING btree (harness_slug, id)
    WHERE harness_slug IS NOT NULL;

-- The wake-up rail (mirrors coord_event_log's notify_coord_event_log, migration
-- 126): every insert fires NOTIFY on the 'agent_activity' channel with payload
-- '<workspace_id>::<owner_id>', so a push consumer (the pui fleet view over
-- /api/activity/stream) LISTENs + refreshes instantly instead of polling.
-- Listener-less NOTIFY is a cheap no-op.
CREATE OR REPLACE FUNCTION harness_shared.notify_agent_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  PERFORM pg_notify('agent_activity', COALESCE(NEW.workspace_id, '') || '::' || COALESCE(NEW.owner_id, ''));
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS agent_activity_notify_trg ON harness_shared.agent_activity;
CREATE TRIGGER agent_activity_notify_trg
  AFTER INSERT ON harness_shared.agent_activity
  FOR EACH ROW EXECUTE FUNCTION harness_shared.notify_agent_activity();

-- harness_app is the least-privilege ship role (the activity:report write path);
-- harness_zero gets read parity with sibling tables (migration 136/138 pattern).
GRANT SELECT, INSERT, DELETE ON harness_shared.agent_activity TO harness_admin, harness_app;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.agent_activity_id_seq TO harness_admin, harness_app;
GRANT SELECT ON harness_shared.agent_activity TO harness_zero;

COMMIT;
