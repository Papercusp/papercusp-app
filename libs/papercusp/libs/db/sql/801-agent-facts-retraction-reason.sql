-- Preserve the actor and rationale for deliberate standing-fact retractions.
-- A timestamp alone cannot explain why a conclusion stopped being true.

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS retracted_by text,
  ADD COLUMN IF NOT EXISTS retraction_reason text;

COMMENT ON COLUMN harness_shared.agent_facts.retracted_by IS
  'Principal that deliberately retracted this fact; NULL for legacy/system expiry or eviction.';

COMMENT ON COLUMN harness_shared.agent_facts.retraction_reason IS
  'Why the fact stopped being true; retained with the soft-retracted row for audit.';
