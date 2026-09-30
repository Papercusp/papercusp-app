-- unify-agent-spawn-chokepoint-2026-06-06 (P-011): orphaned-spawn reclaim lease.
--
-- A harness_shared.spawned_agents row in status 'running'/'restarting' whose
-- launching operator host died was NEVER reclaimed — no lease/heartbeat existed
-- (the operator-spawn.ts comment claiming "the lease/timeout reclaims them" was
-- aspirational). Such rows count forever against the global concurrency ceiling
-- (MAX_CONCURRENT_SPAWNS / maxSimultaneousAgents), slowly poisoning it.
--
-- The live host now heartbeats heartbeat_at for its own in-flight spawns; a
-- periodic + opportunistic sweep (reclaimOrphanedSpawns) flips active rows whose
-- heartbeat went stale beyond the threshold to 'failed', freeing the ceiling.
-- ADD COLUMN ... DEFAULT now() fills existing rows at apply time, so a deploy
-- doesn't instantly reclaim legitimately-running spawns on the first sweep.
ALTER TABLE harness_shared.spawned_agents
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz NOT NULL DEFAULT now();

-- Sweep predicate: active rows by staleness.
CREATE INDEX IF NOT EXISTS spawned_agents_active_heartbeat_idx
  ON harness_shared.spawned_agents (heartbeat_at)
  WHERE status IN ('running', 'restarting');
