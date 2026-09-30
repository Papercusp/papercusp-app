-- 229: per-spawn model override observability (queen-model-tier-selection-2026-06-11 P-003).
-- The resolved model spec + tier a spawn was launched at — what the queen picked
-- vs. whether the task succeeded is the trust mechanism (and the training data
-- for a smarter tier policy later). NULL = no per-spawn override (the role's
-- standing AGENT_MODELS / ROLE_MODEL_DEFAULTS resolution applied).
ALTER TABLE harness_shared.spawned_agents
  ADD COLUMN IF NOT EXISTS model_spec TEXT NULL,
  ADD COLUMN IF NOT EXISTS model_tier TEXT NULL;

COMMENT ON COLUMN harness_shared.spawned_agents.model_spec IS
  'Per-spawn resolved model spec (<modelId>[:<effort>]) threaded as PAPERCUSP_SPAWN_MODEL. NULL = no per-spawn override.';
COMMENT ON COLUMN harness_shared.spawned_agents.model_tier IS
  'Tier name the spec resolved from (post-clamp), when the spawn was tier-driven. NULL = direct spec or no override.';
