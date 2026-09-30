-- 1202-consult-expert-routing-settings.sql — consult-expert-routing-2026-09-22 P-005.
--
-- Single-row-per-workspace JSONB settings for consult EXPERT ROUTING: the
-- ranked allowlist of models permitted to ANSWER a consult (D-004) and the
-- stage-2 recency half-life the relevance router compares candidates with
-- (D-001 §2). The operator-state idiom (migration 020; exact sibling of
-- knowledge_pack_config, migration 639 / operator_rate_limit_config, 161), so
-- readOperatorState/writeOperatorState drive it with ON CONFLICT (workspace_id).
--
-- Payload shape:
--   { "allowlist": [{ "rank": 1, "agent": "claude", "model": "opus" }, ...],
--     "recencyHalfLifeDays": 7 }
--
-- WHY THE TABLE MAY BE EMPTY, AND WHY THAT IS SAFE. Empty (or not-yet-applied)
-- means the code falls back to DEFAULT_EXPERT_MODEL_ALLOWLIST +
-- DEFAULT_RECENCY_HALF_LIFE_DAYS — the owner's stated seed. This list is read on
-- the dispatch critical path, so "no row" must degrade to the seed, never to
-- "no expert routing at all".
--
-- ⚠ RECENCY IS COMPARISON-ONLY [owner 2026-09-22]: "recently should only be
-- considered when comparing... If we have like any expert floor that an agent
-- has to pass, the recency shouldnt be considered for this." recencyHalfLifeDays
-- therefore feeds stage 2 (ranking) only; stage 1 qualification stays
-- recency-free, so an owner's vacation cannot strip an agent of expert status.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_consult_expert_routing (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_consult_expert_routing TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_consult_expert_routing TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_consult_expert_routing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_consult_expert_routing_workspace_isolation ON harness_shared.operator_consult_expert_routing;
CREATE POLICY operator_consult_expert_routing_workspace_isolation ON harness_shared.operator_consult_expert_routing
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
