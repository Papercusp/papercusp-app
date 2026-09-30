-- 350-operator-hive-control-policy.sql — live-configurability-audit-2026-06-20 P-015.
--
-- operator_hive_control_policy — one JSONB row per workspace backing hive:control_policy: the
-- placement-watchdog thresholds (breakerThreshold, recoveryDebounceMs, dormancyGraceMs,
-- infraBreakerThreshold), retiring the PAPERCUSP_HIVE_PLACEMENT_* env gates. Each field is an OVERRIDE
-- over the consumer's env/baked default — absent ⇒ the existing default ⇒ byte-identical.
-- placementConfig() overlays a sync-cached read of this row over its env defaults so all consumers
-- (watchdog sweep + UI + metrics) see the override.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_hive_control_policy (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_hive_control_policy TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_hive_control_policy TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_hive_control_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_hive_control_policy_workspace_isolation ON harness_shared.operator_hive_control_policy;
CREATE POLICY operator_hive_control_policy_workspace_isolation ON harness_shared.operator_hive_control_policy
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
