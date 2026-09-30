-- 401-operator-capability-tiers.sql — live-configurability-audit-2026-06-20 P-010.
--
-- operator_capability_tiers — one JSONB row per workspace backing capability_tier:set. payload =
-- { tiers: { "<capability>": "low" | "medium" | "high" } }. Read into a D-010 SYNC cache GATED by the
-- DARK papercusp-auth-config-overrides flag (the §G auth-config umbrella) and consulted by
-- papercuspTierFor (agent-mcp) BEFORE its baked EXACT table — so a deliberate runtime re-tier (the
-- EI-99/EI-111 mis-tiering class) takes effect without a deploy for every RUNTIME tierFor caller (the
-- capability catalog/palette projection + the decision-ledger posture). Flag OFF (default) ⇒ cache
-- empty ⇒ papercuspTierFor uses its baked table ⇒ byte-identical.
--
-- SCOPE NOTE: load-time-STAMPED tier consumers (endpoint-auth-tiers exposure gate, watchdog per-tool
-- timeout) re-stamp on the next operator boot — they pick up an override after a restart, not live.
-- Widening to live consumer-side re-resolution is an owner decision (plan D-010 cluster).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_capability_tiers (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_capability_tiers TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_capability_tiers TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_capability_tiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_capability_tiers_workspace_isolation ON harness_shared.operator_capability_tiers;
CREATE POLICY operator_capability_tiers_workspace_isolation ON harness_shared.operator_capability_tiers
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
