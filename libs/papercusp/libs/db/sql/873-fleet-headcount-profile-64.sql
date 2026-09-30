-- WI-40321 / rem-dream-recombination-2026-08-17#D-008
-- Persisted desired fleet size may span several capacity-clamped launch waves.
-- FORWARD-COMPAT: the runner executes this whole file in one transaction, so
-- deployed readers see either the old 1..12 check or its 1..64 superset; no
-- column, uniqueness arbiter, or value accepted by deployed code is removed.

ALTER TABLE harness_shared.agent_fleets
  DROP CONSTRAINT IF EXISTS agent_fleets_headcount_target_positive;

ALTER TABLE harness_shared.agent_fleets
  ADD CONSTRAINT agent_fleets_headcount_target_positive
  CHECK (headcount_target IS NULL OR headcount_target BETWEEN 1 AND 64);
