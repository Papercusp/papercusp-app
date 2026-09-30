-- 357-agent-usage-account-attribution.sql
-- P-015 (codex-omp-claude-feature-parity-2026-06-21): add provider-account
-- attribution to agent_usage_samples so cost/usage can be split by the routed
-- Claude/Codex account instead of only by provider/model/role.
--
-- Nullable + additive: pre-migration rows and routes without account pinning
-- stay NULL. The partial index supports workspace-window account rollups.

ALTER TABLE harness_shared.agent_usage_samples
  ADD COLUMN IF NOT EXISTS account_id text;

CREATE INDEX IF NOT EXISTS agent_usage_samples_ws_account_ts_idx
  ON harness_shared.agent_usage_samples (workspace_id, account_id, ts DESC)
  WHERE account_id IS NOT NULL;
