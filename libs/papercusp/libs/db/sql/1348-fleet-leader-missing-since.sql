-- 1348: persist the first complete observation that a registered fleet leader
-- is no longer live. `updated_at` tracks unrelated fleet metadata too, so it
-- cannot safely anchor the automatic-succession grace period.
ALTER TABLE harness_shared.agent_fleets
  ADD COLUMN IF NOT EXISTS leader_missing_since_ms bigint;

COMMENT ON COLUMN harness_shared.agent_fleets.leader_missing_since_ms IS
  'Epoch milliseconds from the first complete liveness observation that the registered leader is ended or absent; NULL while no verified absence episode is active.';
