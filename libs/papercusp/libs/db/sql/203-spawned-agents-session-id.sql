-- 203-spawned-agents-session-id.sql
-- hive-agent-tabs-psu-tui-2026-06-09 P-016 / D-007.
--
-- The NATIVE resume id for a headless invoke-once BEE run — the nursery analog
-- of adv_sessions.session_id (migration 115, which carries it for interactive
-- psu sessions). The operator-spawn engine mints a forced `claude --session-id`
-- UUID for CLAUDE bees and records it here, so the unified hive-tabs bee pane can
-- attach an interactive Claude TUI with `claude --resume <session_id>` (P-004 /
-- D-007). NULL for omp bees (they resume by thread id), codex bees (rollout), and
-- any pre-flag row — the attach falls back to the read-only watch view there.
ALTER TABLE harness_shared.spawned_agents
  ADD COLUMN IF NOT EXISTS session_id text;

CREATE INDEX IF NOT EXISTS spawned_agents_session_id_idx
  ON harness_shared.spawned_agents (session_id)
  WHERE session_id IS NOT NULL;
