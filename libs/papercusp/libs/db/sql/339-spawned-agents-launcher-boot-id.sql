-- 339-spawned-agents-launcher-boot-id.sql
-- EI-2186: the spawn ceiling jammed at 8/8 with 0 live bees after the 2026-06-19
-- host restart — stale admission debits from killed-mid-flight spawns never freed.
--
-- ROOT CAUSE the existing reclaim (mig 228, EI-85) could not fix: it leans on a
-- /proc/<pid> liveness check, and a `pid` is NOT stable across a host restart —
-- the rebooted box reassigns the same low pids to unrelated processes. A stale
-- `launch`-kind row (Queen wake / overwatch loopback) uses the permissive
-- "any live process" check, so a reused pid reads as ALIVE → the row is never
-- reclaimed, its heartbeat is bumped each sweep, and it consumes a ceiling slot
-- forever. Result: maxSimultaneousAgents reads N/N with ~0 live bees and NO bee
-- can be placed fleet-wide.
--
-- FIX: record a per-process boot id (a nonce minted once per operator process)
-- on each nursery row. A `running`/`restarting` row attributed to THIS host but
-- carrying a DIFFERENT boot id is, by construction, owned by a dead prior
-- incarnation — provably dead, immune to pid reuse. The boot-time reconcile
-- (reconcileSpawnAdmissionOnBoot) and the periodic reclaim use it to free stale
-- debits deterministically. Rows predating this column (launcher_boot_id IS NULL)
-- fall back to the unchanged pid/heartbeat path — safe.
ALTER TABLE harness_shared.spawned_agents
    ADD COLUMN IF NOT EXISTS launcher_boot_id text;

-- No new index: the boot reconcile + the spawn-ceiling-jam detector both scan only
-- the ACTIVE set ('running'/'restarting'), which is bounded by maxSimultaneousAgents
-- (tens of rows) — a seq scan over it is cheap, and `spawned_agents_running_idx`
-- (workspace_id, status) already covers the detector's per-workspace read.
