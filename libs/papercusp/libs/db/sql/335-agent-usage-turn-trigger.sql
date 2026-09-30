-- 335-agent-usage-turn-trigger.sql
-- B-TOK-ROLL / B-TOK-4 (token-tracking-plan-and-briefs-2026-06-20): per-turn TRIGGER
-- attribution on agent_usage_samples, so coordination-driven LLM spend is queryable
-- at a finer grain than role.
--
-- WHY: ~96% of LLM spend is fleet/coordination-driven (7d: fleet $2,980 vs interactive
-- $135), and the dominant cost is the queen re-reading giant cached contexts on each
-- WAKE. The role column gives a coarse coord-vs-user split today; turn_trigger separates
-- WHY a turn ran — coord-wake / cron / autoloop / user — so "tokens consumed by
-- coord-triggered turns" (the lens the owner asked for) is a direct SUM.
--
-- Additive + nullable (mirrors session_id/plan_id/tool_name): existing rows + any path
-- that does not stamp PAPERCUSP_TURN_TRIGGER stay NULL → the breakdown loader buckets
-- them 'unattributed' and reports triggerAttributionAvailable:false until population
-- lands (deploy-gated, like plan_id). Behavior-neutral.
--
-- The migration runner wraps each file in its own transaction (strips psql
-- metacommands), so NO top-level BEGIN;/COMMIT;/\set (migration-runner.js contract;
-- lint:migrations). Plain (non-CONCURRENT) CREATE INDEX is transaction-safe in the wrapper.

ALTER TABLE harness_shared.agent_usage_samples
  ADD COLUMN IF NOT EXISTS turn_trigger text;

-- Per-trigger newest-first read (the coord-cost-by-trigger breakdown sums tokens/$ by
-- the turn trigger, windowed). Partial — only attributed rows participate.
CREATE INDEX IF NOT EXISTS agent_usage_samples_ws_trigger_ts_idx
  ON harness_shared.agent_usage_samples (workspace_id, turn_trigger, ts DESC)
  WHERE turn_trigger IS NOT NULL;
