-- 393-operator-scout-budget.sql — live-configurability-audit-2026-06-20 P-022.
--
-- operator_scout_budget — one JSONB row per workspace backing learning:set-scout-budget.
-- payload = { workspaceCeilingUsd?: number }. The runtime override of the workspace-wide
-- Scout spend ceiling that scoutWorkspaceCeilingGate consults before a tick — previously
-- settable ONLY via the PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD env (a baked env value-gate,
-- P-023). Resolution order: this override ?? the env ?? DEFAULT_SCOUT_WORKSPACE_CEILING_USD
-- (10.0). Empty row (default) ⇒ env/default fallback ⇒ byte-identical to before this seam.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_scout_budget (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_scout_budget TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_scout_budget TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_scout_budget ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_scout_budget_workspace_isolation ON harness_shared.operator_scout_budget;
CREATE POLICY operator_scout_budget_workspace_isolation ON harness_shared.operator_scout_budget
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
