-- 1047 — spawn governor observation (P-003 of spawn-door-governor-migration-2026-08-31)
--
-- WHY: `spawnAgentInHarness` is a second agent-spawn door that never crosses the
-- governor admission seam (WI-590490). Before any caller is bound to that seam,
-- P-003 ships an OBSERVE-ONLY receipt: record the admission decision that WOULD
-- have been made, bind nothing, reject nothing. P-004 then derives the real
-- numbers — spawn rate, burst shape, per-caller distribution across the seven
-- callers, and the worst-case wait a live admit would have imposed on a recovery
-- wake — from the accumulated rows. Per plan D-003 that last number is what
-- decides whether the recovery-path callers may take a blocking admit at all.
--
-- WHY A COLUMN AND NOT A TABLE (plan D-008): the resource governor has no durable
-- receipt store today — `harness_shared.admission_runs` is the idea-promotion
-- pipeline (run_kind census|promoter-tick|…), a name-only false friend, and the
-- governor's own queue is `memory-admission-queue-store.ts`. The observation is
-- one fact per spawn, and `spawned_agents` already holds exactly one row per
-- spawn keyed by the same `spawn_id`, so this is the smallest extension of an
-- existing surface rather than a new parallel one.
--
-- EXPAND-ONLY: a nullable ADD COLUMN with no default and no backfill. Nothing
-- reads it until the P-003 writer lands, and existing rows stay valid as NULL,
-- so no FORWARD-COMPAT acknowledgment is required — the currently-deployed
-- release simply never selects this column. There is deliberately no NOT NULL
-- and no CHECK: an observation is evidence, and a constraint that can reject a
-- write would hand this column the power to fail a spawn, which is the one
-- property P-003 exists to not have.

ALTER TABLE harness_shared.spawned_agents
  ADD COLUMN IF NOT EXISTS governor_observation jsonb;

COMMENT ON COLUMN harness_shared.spawned_agents.governor_observation IS
  'OBSERVE-ONLY governor admission receipt (P-003, plan spawn-door-governor-migration-2026-08-31): the admission decision that WOULD have been made for this spawn, written best-effort AFTER the admission transaction commits and never inside it. Binds nothing and rejects nothing; NULL means no observation was recorded (writer disabled, pre-P-003 row, or a best-effort write that was dropped) and never that the spawn was refused. Read it as evidence for P-004, not as a control signal.';

-- Partial index: every query over this column is "the rows that HAVE an
-- observation", and observed rows are a small minority of the table until the
-- writer has been on for a while. Indexing only non-NULL keeps it proportional
-- to the observed set instead of the whole spawn history.
CREATE INDEX IF NOT EXISTS spawned_agents_governor_observation_idx
  ON harness_shared.spawned_agents (workspace_id, started_at DESC)
  WHERE governor_observation IS NOT NULL;
