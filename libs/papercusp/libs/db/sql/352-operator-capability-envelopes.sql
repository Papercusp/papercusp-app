-- 352-operator-capability-envelopes.sql — live-configurability-audit-2026-06-20 P-009.
--
-- operator_capability_envelopes — one JSONB row per workspace backing capability_envelope:set_role
-- (+ :set_protected). payload = { roleEnvelopes: { <role>: {denyCapabilities?, allowCapabilities?} },
-- protectedAdditions: string[] }. The runtime override of the per-role capability envelope, read into
-- a D-010 SYNC cache (gated by the dark papercusp-capability-envelope-overrides flag) and merged over
-- the baked ROLE_ENVELOPES + PROTECTED_CAPABILITY_GLOBS at the dispatch checkCapabilityEnvelope step.
-- Flag OFF (default) ⇒ cache empty ⇒ byte-identical. protectedAdditions is TIGHTEN-ONLY (append; the
-- universal floor is never removable).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_capability_envelopes (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_capability_envelopes TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_capability_envelopes TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_capability_envelopes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_capability_envelopes_workspace_isolation ON harness_shared.operator_capability_envelopes;
CREATE POLICY operator_capability_envelopes_workspace_isolation ON harness_shared.operator_capability_envelopes
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
