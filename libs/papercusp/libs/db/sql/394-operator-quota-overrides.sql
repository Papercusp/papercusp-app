-- 394-operator-quota-overrides.sql — live-configurability-audit-2026-06-20 P-018.
--
-- operator_quota_overrides — one JSONB row per workspace backing quota:set_tool. payload =
-- { overrides: { "<toolName>|<role>": { perChunk?, perRun?, perDay? } } }. The runtime per-(tool,role)
-- quota override read into a D-010 SYNC cache and MERGED OVER the tool's baked rolesQuota[role] at the
-- dispatch quota step (projected-tool-deps computeQuotaWindow wrapper) — so an operator can raise (or
-- tighten) a single tool's per-role throttle cap mid-incident without a deploy. Empty row (default) ⇒
-- cache empty ⇒ the baked rolesQuota applies ⇒ byte-identical. NOT flag-gated (operational, not an
-- auth surface): a quota cap rate-limits call COUNT in a window; it never widens which tools a role
-- may call.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_quota_overrides (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_quota_overrides TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_quota_overrides TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_quota_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_quota_overrides_workspace_isolation ON harness_shared.operator_quota_overrides;
CREATE POLICY operator_quota_overrides_workspace_isolation ON harness_shared.operator_quota_overrides
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
