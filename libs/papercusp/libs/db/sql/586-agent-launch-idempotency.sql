-- Migration 586 — agent-launch idempotency ledger
-- (agent-launch-resume-primitives-2026-07-12 P-014).
--
-- `capability:launch-agent` opens REAL desktop windows / headless agent
-- processes: a re-fired tool call (a client retry after a timeout, a re-planned
-- step, a loop that fires twice) launches a SECOND set of agents that nobody
-- asked for — the 2026-07-03 "12 windows" incident class. The caller passes an
-- `idempotencyKey`; the first launch claims it here (INSERT ... ON CONFLICT DO
-- NOTHING), a replay finds the claim and returns the ORIGINAL summary with
-- `deduped: true` instead of launching again. Same precedent as spawned_agents'
-- idempotency key (migration 219, EI-73), but agent launches have no
-- spawned_agents row to hang it on — the adv_sessions row is written later, by
-- the launcher itself.
--
-- Keyed by (workspace_id, idempotency_key): multi-tenant, like every other
-- shared table. `summary` carries what the original call reported so a replay is
-- informative, not just refused.

CREATE TABLE IF NOT EXISTS harness_shared.agent_launch_idempotency (
  workspace_id      text   NOT NULL,
  idempotency_key   text   NOT NULL,
  launched_at       bigint NOT NULL,
  launched_by       text,
  summary           jsonb  NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, idempotency_key)
);

COMMENT ON TABLE harness_shared.agent_launch_idempotency IS
  'capability:launch-agent dedupe ledger (P-014): the first launch for an idempotency key claims a row; a replay reads it back and reports deduped:true instead of opening duplicate agent windows.';

-- Claims age out (the janitor DELETE in claimAgentLaunch prunes by age); index
-- the timestamp so that prune stays a range scan, not a seq scan.
CREATE INDEX IF NOT EXISTS agent_launch_idempotency_launched_at_idx
  ON harness_shared.agent_launch_idempotency (launched_at);
