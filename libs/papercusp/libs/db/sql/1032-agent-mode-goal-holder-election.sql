-- 1032-agent-mode-goal-holder-election.sql
-- Number reserved via db:next-migration (harness_shared.migration_reservations).
--
-- P-002 (work-on-everything-stewardship-remediation-2026-08-30): GOAL
-- mode rows remain the historical holder candidates, but only one row is the
-- effective lease at a time. The mode writer serializes elections per
-- workspace+goal and stamps the successor row with a monotonically increasing
-- epoch plus the bounded predecessor handoff it displaced.

ALTER TABLE harness_shared.agent_modes
  ADD COLUMN IF NOT EXISTS goal_lease_epoch bigint,
  ADD COLUMN IF NOT EXISTS goal_handoff_from_owner_id text,
  ADD COLUMN IF NOT EXISTS goal_handoff_expires_at timestamptz;

COMMENT ON COLUMN harness_shared.agent_modes.goal_lease_epoch IS
  'GOAL-only effective-holder election epoch. Highest epoch for workspace+subject is sovereign; NULL is legacy/non-GOAL.';
COMMENT ON COLUMN harness_shared.agent_modes.goal_handoff_from_owner_id IS
  'GOAL-only predecessor allowed to overlap the elected successor through goal_handoff_expires_at.';
COMMENT ON COLUMN harness_shared.agent_modes.goal_handoff_expires_at IS
  'GOAL-only bounded overlap deadline; overlap after this instant is a health failure.';

-- Deterministic one-time adoption of historical rows. Newer set_at wins; an
-- owner-id tie-break makes simultaneous legacy rows converge everywhere.
WITH ranked AS (
  SELECT workspace_id, owner_id, axis_key,
         row_number() OVER (
           PARTITION BY workspace_id, subject
           ORDER BY set_at ASC, owner_id DESC
         )::bigint AS election_epoch
    FROM harness_shared.agent_modes
   WHERE mode = 'goal' AND subject IS NOT NULL
)
UPDATE harness_shared.agent_modes am
   SET goal_lease_epoch = ranked.election_epoch
  FROM ranked
 WHERE am.workspace_id = ranked.workspace_id
   AND am.owner_id = ranked.owner_id
   AND am.axis_key = ranked.axis_key
   AND am.goal_lease_epoch IS NULL;

CREATE INDEX IF NOT EXISTS agent_modes_goal_election_idx
  ON harness_shared.agent_modes (workspace_id, subject, goal_lease_epoch DESC)
  WHERE mode = 'goal' AND subject IS NOT NULL;
