-- 262-risk-tier-authority-schema.sql
--
-- queen-autonomy-policy-2026-06-13 (Brief B-01 / P-010 + P-011): the risk-tier +
-- authority schema. Two graded autonomy axes, kept SEPARATE on purpose (D-002):
--
--   • risk_tier — the graded decision-risk scale (trivial · low · moderate ·
--     high · critical). `needs-human` is no longer a stored kind; it is the
--     DERIVED top band of this scale (a tier above the effective per-category
--     ceiling — see @papercusp/plan-parser risk-model.ts deriveNeedsHuman).
--   • authority — `owner` means the decision is the owner's by right and ALWAYS
--     gates to a human regardless of the computed risk; `system` is the default.
--
-- These are the autonomy DECISION axes. The decision surfaces are jsonb today —
-- plan items ride `harness_plans.items` (the derived index, recomputed from
-- canonical content by the parser) and coord escalations ride
-- `coord_event_log.body` (the EscalationRecord; its severity folds into risk_tier
-- in the operator, P-013) — so neither needs DDL. The one real escalation TABLE
-- (`harness_escalations` — git-sync / steering / orchestrator escalations to the
-- human) gets typed columns here so it can carry risk/authority first-class.
--
-- work_items (the harness_features_consolidated UNION view) is intentionally NOT
-- touched: D-013 keeps work_items as EXECUTION, not the decision Queue, and that
-- 47-column UNION-ALL view + INSTEAD-OF triggers is the wrong place for the
-- decision axes. A typed column there is a clean follow-on if the gate ever needs
-- per-work-item risk.
--
-- BEHAVIOR-NEUTRAL (D-007): both columns are nullable with no default and no
-- reader today — the day this lands, behavior is identical to today. Autonomy
-- widens only when the owner lowers a ceiling, and only after the arming gate
-- (P-092).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS (each column added at most once; the named
-- CHECK rides the first add and is skipped on re-run). Existing table grants cover
-- the new columns — no re-grant needed.

ALTER TABLE harness_shared.harness_escalations
  ADD COLUMN IF NOT EXISTS risk_tier text
    CONSTRAINT harness_escalations_risk_tier_check
    CHECK (risk_tier IS NULL OR risk_tier IN ('trivial', 'low', 'moderate', 'high', 'critical')),
  ADD COLUMN IF NOT EXISTS authority text
    CONSTRAINT harness_escalations_authority_check
    CHECK (authority IS NULL OR authority IN ('system', 'owner'));

COMMENT ON COLUMN harness_shared.harness_escalations.risk_tier IS
  'Autonomy decision-risk tier (queen-autonomy-policy B-01): trivial|low|moderate|high|critical, or NULL (unset). The graded scale the autonomy gate consumes; needs-human is its derived top band. Distinct from importance (the ranker axis).';
COMMENT ON COLUMN harness_shared.harness_escalations.authority IS
  'Decision authority (queen-autonomy-policy P-011): owner|system, or NULL (defaults to system). authority=owner ALWAYS gates to a human regardless of computed risk.';
