-- 161-operator-rate-limit-config-and-usage-samples.sql — rate-limit-layer-v2-2026-06-05.
--
-- Two tables for the rate-limit layer's top half (Brief 20):
--
-- (1) operator_rate_limit_config (D-004) — the user's live-editable fleet knobs:
--     `maxSimultaneousAgents` (the fleet-wide concurrent-agent cap the governor + orchestrator
--     read live) + `concurrencyFloor` (the AIMD floor, D-005). Single-row-per-workspace JSONB,
--     the operator-state idiom (migration 020 / pot_wake 158). Default empty → code falls back to
--     DEFAULT_RATE_LIMIT_CONFIG (max 16, floor 1), so the table being empty is safe.
--
-- (2) agent_usage_samples (D-002) — one row per governed agent call: the token usage (from the
--     subprocess `{"type":"result",…usage}` JSONL event, visible even when rate-limit headers
--     are not) + the `anthropic-ratelimit-*` limit/remaining/reset captured on the in-process
--     meridian path. The read-model computes usage% (where a limit is known) + token throughput
--     + $spend from these. Append-only; nullable columns (different capture points populate
--     different subsets). Extends cross-backend-cost-capture.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

-- (1) ----------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS harness_shared.operator_rate_limit_config (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_rate_limit_config TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_rate_limit_config TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_rate_limit_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_rate_limit_config_workspace_isolation ON harness_shared.operator_rate_limit_config;
CREATE POLICY operator_rate_limit_config_workspace_isolation ON harness_shared.operator_rate_limit_config
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- (2) ----------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS harness_shared.agent_usage_samples (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  ts                    BIGINT NOT NULL,                 -- epoch ms of the sample
  bucket_key            TEXT NOT NULL,                   -- '<provider>:<modelClass>', e.g. 'anthropic:opus'
  provider              TEXT NOT NULL,                   -- 'anthropic' | 'openai' | 'unknown'
  model_class           TEXT NOT NULL,                   -- 'opus' | 'sonnet' | 'haiku' | 'default' | 'self'
  source                TEXT NOT NULL,                   -- 'headers' (in-process meridian) | 'jsonl' (subprocess result)
  -- Token usage (from the result event / SDK usage). Nullable: not every source has all fields.
  input_tokens          BIGINT,
  output_tokens         BIGINT,
  cache_read_tokens     BIGINT,
  cost_usd              DOUBLE PRECISION,
  -- anthropic-ratelimit-* snapshot (header-bearing paths only — subscription CLI has none).
  rl_requests_limit     BIGINT,
  rl_requests_remaining BIGINT,
  rl_tokens_limit       BIGINT,
  rl_tokens_remaining   BIGINT,
  rl_reset_at           BIGINT                            -- epoch ms
);

-- Read-model queries are "recent samples per workspace[, per bucket]" → index ts desc by workspace.
CREATE INDEX IF NOT EXISTS agent_usage_samples_ws_ts_idx
  ON harness_shared.agent_usage_samples (workspace_id, ts DESC);
CREATE INDEX IF NOT EXISTS agent_usage_samples_ws_bucket_ts_idx
  ON harness_shared.agent_usage_samples (workspace_id, bucket_key, ts DESC);

GRANT SELECT, INSERT, DELETE ON harness_shared.agent_usage_samples TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.agent_usage_samples TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.agent_usage_samples ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_usage_samples_workspace_isolation ON harness_shared.agent_usage_samples;
CREATE POLICY agent_usage_samples_workspace_isolation ON harness_shared.agent_usage_samples
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
