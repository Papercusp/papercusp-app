-- 1331-goal-lease-epoch-history.sql — WI-10005240 (goal lease epoch reuse)
--
-- A GOAL holder election mints `next_epoch = MAX(goal_lease_epoch) + 1`, but the
-- MAX ran over LIVE harness_shared.agent_modes rows only. When the highest-epoch
-- holder exits, its row is deleted and the next election re-issues the SAME epoch
-- to a different owner (measured 2026-10-02 on goal 60d3a8: epoch 5 issued to
-- su-ce50c06d, then again to su-9ec5d030 after it exited). A fencing epoch that
-- can repeat does not fence: work stamped by the old holder is indistinguishable
-- from the new holder's.
--
-- Fix: the existing append-only transition log, agent_mode_changes, records the
-- goal subject and the epoch each election minted. The election then takes
-- GREATEST(live max, history max) + 1 (packages/operator-core/lib/modes/store.ts),
-- so an epoch survives its holder's exit. The election's audit row is written in
-- the same transaction that holds the per-goal advisory lock, so the history is
-- atomic with the mint.
--
-- Additive only: two nullable columns and a partial index. The backfill appends
-- one history row per goal, carrying its highest LIVE epoch (and that row's
-- owner), so a live holder that exits before the next election cannot have its
-- epoch re-issued either. Epochs of holders that exited before this migration are
-- unrecoverable; the next election still moves past every live epoch.

ALTER TABLE harness_shared.agent_mode_changes
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS goal_lease_epoch bigint;

CREATE INDEX IF NOT EXISTS agent_mode_changes_goal_epoch_idx
  ON harness_shared.agent_mode_changes (workspace_id, subject, goal_lease_epoch DESC)
  WHERE goal_lease_epoch IS NOT NULL;

INSERT INTO harness_shared.agent_mode_changes
  (workspace_id, owner_id, axis_key, old_mode, new_mode, reason, set_by, owner_directed,
   subject, goal_lease_epoch)
SELECT am.workspace_id, am.owner_id, am.axis_key, am.mode, am.mode,
       'backfill: goal lease epoch high-water (WI-10005240)', 'migration:1331', false,
       am.subject, am.goal_lease_epoch
  FROM (
    SELECT DISTINCT ON (workspace_id, subject) *
      FROM harness_shared.agent_modes
     WHERE mode = 'goal'
       AND subject IS NOT NULL
       AND goal_lease_epoch IS NOT NULL
     ORDER BY workspace_id, subject, goal_lease_epoch DESC, set_at DESC, owner_id
  ) am
 WHERE NOT EXISTS (
     SELECT 1 FROM harness_shared.agent_mode_changes c
      WHERE c.workspace_id = am.workspace_id
        AND c.subject = am.subject
        AND c.goal_lease_epoch >= am.goal_lease_epoch
   );

COMMENT ON COLUMN harness_shared.agent_mode_changes.goal_lease_epoch IS
  'Epoch minted by a GOAL holder election (WI-10005240). MAX per (workspace_id, subject) is the lease high-water; the next election mints GREATEST(live, history) + 1.';
COMMENT ON COLUMN harness_shared.agent_mode_changes.subject IS
  'Mode subject at the transition (the goal id for GOAL mode).';
