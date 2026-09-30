-- 830: durable fleet launch transaction + recovery state (P-003 / WI-38513).
--
-- A fleet launch is canary-first and may stop after opening only part of the
-- requested cohort. Keep the exact requested/opened/verified/failed identities,
-- wave verdicts, attestation differences, and retry set on the existing fleet
-- registry row so a timeout, operator restart, or caller carry never turns a
-- partial launch into an apparently complete one. The JSON payload is versioned
-- in agent-fleets-store.ts; no parallel launch/recovery store is introduced.
ALTER TABLE harness_shared.agent_fleets
  ADD COLUMN IF NOT EXISTS last_launch_transaction jsonb;

COMMENT ON COLUMN harness_shared.agent_fleets.last_launch_transaction IS
  'Versioned canary-first fleet launch transaction: exact requested/opened/verified/failed member identities, bounded-wave verdicts, attestation diffs, and deterministic recovery instructions.';
