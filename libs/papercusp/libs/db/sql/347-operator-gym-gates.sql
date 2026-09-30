-- 347-operator-gym-gates.sql — live-configurability-audit-2026-06-20 P-012.
--
-- operator_gym_gates — per-(workspace, harness) gym promotion gates backing gym:set-gates:
-- epsilon / delta (the accept-margin gates) + costCeiling. These were an INLINE placeholder
-- ({ epsilon: 0.1, delta: 0.5, costCeiling: 3 }) at gym/autoloop-cycle.ts, self-described as
-- "placeholders until P-014". Per-harness JSONB (the gym config is per-harness). Empty/missing ⇒
-- the inline defaults, so an empty (or absent) table = today's behavior.
--
-- The gym loop is human-gated (autoPromote:false) — these gates only steer the loop's ADVISORY
-- verdict; the human reviews every proposal. Idempotent; additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_gym_gates (
  workspace_id TEXT NOT NULL,
  harness_slug TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, harness_slug)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_gym_gates TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_gym_gates TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_gym_gates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_gym_gates_workspace_isolation ON harness_shared.operator_gym_gates;
CREATE POLICY operator_gym_gates_workspace_isolation ON harness_shared.operator_gym_gates
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
