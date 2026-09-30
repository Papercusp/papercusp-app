-- 1057-attention-standing-automation-policy.sql
-- autonomous-inbox-resolution-2026-08-31 P-006.
--
-- One mutable row per workspace. This extends the existing operator-state /
-- BulkAutomationPolicy plane; it is not a second per-kind authority registry.
-- `payload` stores the two independent standing axes:
--   level: L0 | L1 | L2 (authority ladder; L0 is the shipped default)
--   minConfidence: high | medium | low | insufficient (confidence floor)
-- The run's automation_policy column remains an immutable launch receipt.

CREATE TABLE IF NOT EXISTS harness_shared.operator_attention_automation_policy (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{"level":"L0","minConfidence":"high"}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_attention_automation_policy TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_attention_automation_policy TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_attention_automation_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_attention_automation_policy_workspace_isolation
  ON harness_shared.operator_attention_automation_policy;
CREATE POLICY operator_attention_automation_policy_workspace_isolation
  ON harness_shared.operator_attention_automation_policy
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
