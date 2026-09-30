-- 858-scout-routing-decisions-artifact.sql
--
-- WI-20860583842231472: scout_routed_ideas is deliberately an artifact/outcome
-- ledger and therefore cannot represent a dispatch that produced no routed_ref.
-- Preserve the complete per-cycle RoutingDecision[] beside the already-retained
-- proposals so success, failure (error), and skip (neither routed_ref nor error)
-- reconcile without weakening routed_ref's artifact-reference contract.

ALTER TABLE harness_shared.scout_cycle_stage_artifacts
  ADD COLUMN IF NOT EXISTS routing_decisions jsonb;

COMMENT ON COLUMN harness_shared.scout_cycle_stage_artifacts.routing_decisions IS
  'Complete RoutingDecision[] for the cycle, including failed/skipped decisions without a routed_ref (WI-20860583842231472).';
