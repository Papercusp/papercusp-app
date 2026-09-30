-- 1075: provenance for mode implication cascades.
-- EI-22021178248333012
--
-- A derived AUTO/IDEATE row used to carry only a reason string. When a GOAL
-- ended, that left no safe way to distinguish its derived posture from a mode
-- the agent chose independently. Keep the source mode and subject as JSONB so
-- the generic subject slot works for goals and future subject-bearing modes.
-- Existing rows remain NULL: they predate provenance and must not be guessed to
-- be derived by a cleanup operation.

ALTER TABLE harness_shared.agent_modes
  ADD COLUMN IF NOT EXISTS implied_by jsonb;

COMMENT ON COLUMN harness_shared.agent_modes.implied_by IS
  'Nullable JSONB provenance for a derived mode row: {"mode": source mode id, "subject": source subject or null}. NULL means independently authored or legacy/unknown provenance.';
