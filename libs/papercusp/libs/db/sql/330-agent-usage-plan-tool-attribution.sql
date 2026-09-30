-- 330: per-plan + per-tool token attribution on agent_usage_samples (B-TOK-2,
-- token-tracking-plan-and-briefs-2026-06-20). session_id already landed in mig 279.
--
-- WHY: we burn account quota faster than expected (24h audit: opus = 90% of spend,
-- cache-read = 82% of all tokens) but cannot attribute spend per-PLAN or per-TOOL.
-- plan_id lets the Tokens dashboard (B-TOK-1) sum spend by the plan a run served;
-- tool_name attributes a call to the tool/feature that made it. Both nullable +
-- additive: existing rows + any path that does not supply them stay NULL (mirrors
-- session_id being NULL for non-claude backends). Behavior-neutral.
--
-- The migration runner wraps each file in its own transaction (and strips psql
-- metacommands), so this file carries NO top-level BEGIN;/COMMIT;/\set
-- (migration-runner.js contract; lint:migrations). Plain (non-CONCURRENT) CREATE
-- INDEX is used deliberately so it is transaction-safe inside that wrapper.

ALTER TABLE harness_shared.agent_usage_samples
  ADD COLUMN IF NOT EXISTS plan_id text;

ALTER TABLE harness_shared.agent_usage_samples
  ADD COLUMN IF NOT EXISTS tool_name text;

-- Per-plan newest-first read (the Tokens dashboard sums tokens/$ by the plan a run
-- served, windowed). Partial — only attributed rows participate.
CREATE INDEX IF NOT EXISTS agent_usage_samples_ws_plan_ts_idx
  ON harness_shared.agent_usage_samples (workspace_id, plan_id, ts DESC)
  WHERE plan_id IS NOT NULL;

-- Per-role newest-first read (the by-role top-consumer view — brief's requested
-- (role, ts DESC) index, workspace-scoped to match the table's other indexes).
CREATE INDEX IF NOT EXISTS agent_usage_samples_ws_role_ts_idx
  ON harness_shared.agent_usage_samples (workspace_id, role, ts DESC)
  WHERE role IS NOT NULL;
