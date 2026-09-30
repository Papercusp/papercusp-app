-- 342-operator-scale-policy.sql — live-configurability-audit-2026-06-20 P-006.
--
-- operator_scale_policy — the settable account scale-out TRIGGER policy backing accounts:scale_policy:
-- windowMs (penalty accumulation window) + sustainedPenaltyThreshold (≥N penalties in the window ⇒
-- the account is "sustainedly limited", which gates the PAID auto-scale-out). Single-row-per-workspace
-- JSONB (operator-state idiom). Empty/missing ⇒ DEFAULT_SCALE_POLICY (15min / 3), so an empty (or
-- absent) table = today's behavior.
--
-- NOTE: this tunes WHEN scale-out fires; the provisioning itself stays owner-gated (accounts:scale_out).
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_scale_policy (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_scale_policy TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_scale_policy TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_scale_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_scale_policy_workspace_isolation ON harness_shared.operator_scale_policy;
CREATE POLICY operator_scale_policy_workspace_isolation ON harness_shared.operator_scale_policy
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
