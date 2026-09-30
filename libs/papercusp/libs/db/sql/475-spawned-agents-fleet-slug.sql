-- 475-spawned-agents-fleet-slug.sql
-- WI-1813 (WI-1764 #4 follow-up): stamp the named-fleet slug on the nursery row so
-- per-fleet beeCount is RELIABLE.
--
-- Before this, bee:spawn { fleet } threaded the fleet only to the child's ENV (so the
-- bee auto-joined the fleet's PRESENCE label) — the spawned_agents row itself carried NO
-- fleet linkage. So per-fleet bee counts depended on the bee booting far enough to write
-- a presence row, and countRunningWorkspaceBees had to stay workspace-wide (it could not
-- attribute a running bee to its fleet). Stamping the slug at spawn (operator-spawn.ts,
-- best-effort mirror of the session_id stamp) makes countRunningFleetBees deterministic:
-- every running bee spawned into a fleet is counted under it, presence-independent.
--
-- Additive + nullable — old rows and ungrouped bees keep NULL fleet_slug (simply not
-- attributed to any named fleet); the workspace-wide runningBees still counts them.

ALTER TABLE harness_shared.spawned_agents
  ADD COLUMN IF NOT EXISTS fleet_slug text;

-- countRunningFleetBees filters live bees by (workspace_id, fleet_slug). A partial index
-- scoped to running/restarting bees carrying a fleet keeps the per-fleet count cheap even
-- as the historical spawned_agents table grows.
CREATE INDEX IF NOT EXISTS spawned_agents_fleet_slug_running_idx
  ON harness_shared.spawned_agents (workspace_id, fleet_slug)
  WHERE fleet_slug IS NOT NULL AND child_role = 'bee' AND status IN ('running', 'restarting');
