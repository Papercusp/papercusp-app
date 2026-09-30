-- 228-spawned-agents-pid-host.sql
-- EI-85 (leg c): record the child OS pid + launcher host on each nursery row so
-- the reclaim sweep can DISTINGUISH "launching host died" from "child died".
--
-- Today reclaimOrphanedSpawns blindly flips every 'running' row whose
-- heartbeat_at went stale > 300s to 'failed' ("host presumed dead"). That
-- mislabels two cases: (1) the host was only BRIEFLY paused (GC, a peer's
-- restart-in-progress) but the child is still alive — it gets reclaimed out from
-- under itself; (2) the child really was cgroup-killed — true, but the reason
-- text can't say so. With the child's pid + launcher host recorded, a same-host
-- reclaim checks /proc/<pid> liveness first: a live child is left alone (its
-- heartbeat is bumped), a dead one is reclaimed with an accurate reason. A
-- different-host or pid-less row falls back to the heartbeat-stale reclaim
-- (unchanged) — safe for the federated multi-machine case.
ALTER TABLE harness_shared.spawned_agents
    ADD COLUMN IF NOT EXISTS pid integer,
    ADD COLUMN IF NOT EXISTS launcher_host text;
