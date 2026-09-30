-- 346-operator-auto-implement-policy.sql — live-configurability-audit-2026-06-20 P-011.
--
-- operator_auto_implement_policy — the settable auto-implement risk policy + dispatch limits backing
-- improvements:set-auto-policy: autoKinds (the bug→change→feature graduation dial — CLAUDE.md frames
-- Phase-4 graduation as "a CONFIG change"), protectedPath/Keyword ADDITIONS (D-002 tighten-only: the
-- baked TCB floor is unioned + never removable), maxPerRun, maxAttempts. Single-row-per-workspace
-- JSONB (operator-state idiom). Empty/missing ⇒ DEFAULT_RISK_TIER_POLICY + env/default limits, so an
-- empty (or absent) table = today's behavior.
--
-- Inert until FLAGS.IMPROVEMENT_AUTO_IMPLEMENT (default OFF) is armed. Idempotent; additive.

CREATE TABLE IF NOT EXISTS harness_shared.operator_auto_implement_policy (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_auto_implement_policy TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_auto_implement_policy TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_auto_implement_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_auto_implement_policy_workspace_isolation ON harness_shared.operator_auto_implement_policy;
CREATE POLICY operator_auto_implement_policy_workspace_isolation ON harness_shared.operator_auto_implement_policy
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
