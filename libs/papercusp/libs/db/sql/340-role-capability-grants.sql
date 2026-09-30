-- 340-role-capability-grants.sql — live-configurability-audit-2026-06-20 P-008.
--
-- role_capability_grants — runtime role→capability grants backing capability:grant_role /
-- capability:revoke_role. Unioned into loadRoleCapabilities (role-principal-caps.ts) ALONGSIDE
-- system_principals + BLUEPRINT_ROLE_CAPS, but ONLY when the CAPABILITY_GRANT_TOOL flag is ON
-- (ships dark — the union is flag-gated, so default-OFF = zero behavior change; the grant TOOL
-- also refuses while dark, so the table stays empty until the owner ratifies). One row per
-- (workspace, role); the granted caps are a JSONB string[].
--
-- D-007: the grant TOOL enforces the constraints (no protected-floor caps secrets:*/processes:kill,
-- no grant above the granter's own envelope, operator-authority/never-auto). This table is the store.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.role_capability_grants (
  workspace_id TEXT  NOT NULL,
  role         TEXT  NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, role)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.role_capability_grants TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.role_capability_grants TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.role_capability_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_capability_grants_workspace_isolation ON harness_shared.role_capability_grants;
CREATE POLICY role_capability_grants_workspace_isolation ON harness_shared.role_capability_grants
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
