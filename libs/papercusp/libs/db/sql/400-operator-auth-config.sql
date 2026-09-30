-- 400-operator-auth-config.sql — live-configurability-audit-2026-06-20 P-019.
--
-- operator_auth_config — one JSONB row per workspace backing the §G auth/sandbox dials. payload =
-- { fullAccessRoles?: string[], safeToolsRemove?: string[], sandboxMaskAdditions?: string[],
--   sandboxDenyAllEgress?: boolean }. Read into a D-010 SYNC cache GATED by the DARK
-- papercusp-auth-config-overrides flag:
--   - fullAccessRoles  → auth:set_full_access_roles REPLACES the baked TESTING_FULL_ACCESS_ROLES
--                        bypass set (escalation — the reason this whole cluster is dark);
--   - safeToolsRemove  → clamp:set_safe_tools NARROWS the scoped-SU cross-workspace allowlist
--                        (tighten-only: a remove-set, never an add);
--   - sandboxMaskAdditions / sandboxDenyAllEgress → exec_sandbox:set_policy ADDS sandbox mask dirs
--                        and/or forces deny-all-egress (tighten-only: add-masks / lock-down only).
-- Flag OFF (default) ⇒ cache empty ⇒ every surface uses its baked literal ⇒ byte-identical.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_auth_config (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_auth_config TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_auth_config TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_auth_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_auth_config_workspace_isolation ON harness_shared.operator_auth_config;
CREATE POLICY operator_auth_config_workspace_isolation ON harness_shared.operator_auth_config
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
