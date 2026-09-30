-- 604-operator-context-doors-config.sql — deterministic-context-carry-2026-07-14 P-023.
--
-- operator_context_doors_config — one JSONB row per workspace backing the P-023 config
-- surface over the context-door / compaction-threshold constants (context-doors.ts):
--   payload.defaults  — workspace-level overrides of the baked constants (floor, cap,
--                       divisor, door split, compaction overhead); absent field ⇒ the
--                       baked default ⇒ byte-identical behavior.
--   payload.sessions  — per-ownerId session overrides (TTL = session; provenance-stamped
--                       { setBy, setAt, provenance }; pruned on write, age-filtered on read).
-- Overrides are DELIBERATE decisions set via config:doors-set / config:doors-set-session
-- (audited through the gateway-control harness) — never runtime feedback (plan D-001).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_context_doors_config (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_context_doors_config TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_context_doors_config TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_context_doors_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_context_doors_config_workspace_isolation ON harness_shared.operator_context_doors_config;
CREATE POLICY operator_context_doors_config_workspace_isolation ON harness_shared.operator_context_doors_config
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
