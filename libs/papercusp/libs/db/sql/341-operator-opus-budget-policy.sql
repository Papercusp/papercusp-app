-- 341-operator-opus-budget-policy.sql — live-configurability-audit-2026-06-20 P-005.
--
-- operator_opus_budget_policy — the settable fleet opus-budget shed bands backing fleet:opus_budget:
-- reserveStart (shed background opus→sonnet), reserveHard (also shed normal), nearCap (pace
-- critical), staleMs. Single-row-per-workspace JSONB (operator-state idiom, migration 020 /
-- rate-limit-config 161). Empty/missing ⇒ code falls back to DEFAULT_OPUS_BUDGET_POLICY
-- (0.75 / 0.88 / 0.95), so an empty (or absent) table = today's behavior.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_opus_budget_policy (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_opus_budget_policy TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_opus_budget_policy TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_opus_budget_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_opus_budget_policy_workspace_isolation ON harness_shared.operator_opus_budget_policy;
CREATE POLICY operator_opus_budget_policy_workspace_isolation ON harness_shared.operator_opus_budget_policy
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
