/**
 * machine-capability-tags.ts — detects THIS machine's real DG-3 shard-
 * scheduling capability tags (platform/deps/DB) so `writePresence` can carry
 * them on `coord_presence.capability_tags` instead of a placeholder (WI-1546,
 * Gate DG-3 follow-up — see pot-git/gate/scheduling.ts's file header, which
 * named this exact wiring gap).
 *
 * WHY DETECTED HERE, NOT IN scheduling.ts: scheduling.ts is deliberately pure
 * (no I/O — "Pure: node:crypto only" per its own header) so its matching
 * logic (`machineCanRunShard` / `eligibleShards`) stays trivially unit-tested.
 * This module is the one place that actually PROBES the machine.
 *
 * WHY SAFE TO PROBE FROM THE OPERATOR PROCESS: `writePresence` runs inside
 * the operator's own long-lived server process, not the calling agent's OS
 * process (see presence.ts's file-header note re: host/pid) — but capability
 * tags are a MACHINE-level fact (docker/pg availability), true for every
 * process on that box, unlike a per-agent pid. Each machine in this fleet's
 * cross-machine topology (tower/VM/mac) runs its OWN local operator, so
 * probing from within it correctly answers "does THIS machine have X" for
 * whichever machine's local gate-runner would actually execute a claimed
 * shard.
 *
 * Cached per-process (module-level): a machine's capability set does not
 * change turn-to-turn, and `docker info` is not cheap enough to run on every
 * presence write (the hottest path in the whole coordination substrate).
 */
import { execFile } from 'node:child_process';

/** The exact tag vocabulary `pot-git/gate/scheduling.ts` matches against
 *  (`shardRequiredTags` / `DEFAULT_MACHINE_TAGS`) — kept as plain strings
 *  there (not the typed `ShardCapability` union from hermeticity.ts), so this
 *  module mirrors that, deliberately not re-coupling the two vocabularies. */
export type MachineTagProbeDeps = {
  /** Injectable for tests — defaults to a real `docker info` probe. */
  probeDocker?: () => Promise<boolean>;
  /** Injectable clock-free timeout (ms) for the docker probe. Default 1500. */
  dockerProbeTimeoutMs?: number;
};

function defaultProbeDocker(timeoutMs: number): () => Promise<boolean> {
  return () =>
    new Promise<boolean>((resolve) => {
      const child = execFile(
        'docker',
        ['info', '--format', '{{.ServerVersion}}'],
        { timeout: timeoutMs },
        (err) => resolve(!err),
      );
      // Belt-and-suspenders: execFile's own `timeout` option already kills a
      // hung process, but guard the promise itself too so a probe can never
      // hang writePresence's caller indefinitely on an odd platform quirk.
      const guard = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* best-effort */
        }
        resolve(false);
      }, timeoutMs + 250);
      child.once('exit', () => clearTimeout(guard));
    });
}

/**
 * Detect this machine's capability tags. Pure result over injected/real
 * probes — no caching here (see `getCachedMachineCapabilityTags` for the
 * memoized, production entry point).
 *
 * 'node': trivially true — this code only ever runs under a node toolchain.
 * 'docker' + 'pg': both keyed off ONE `docker info` probe. Today the only
 * modeled DB dependency (hermeticity.ts) is testcontainers-provisioned
 * Postgres for integration shards, which itself requires docker — so a
 * machine with a live Docker daemon can run BOTH docker- and pg-tagged
 * shards, and one without cannot run either. Kept as two separate tags
 * (matching `shardRequiredTags`'s existing three-tag vocabulary) so a future
 * native-PG-without-docker probe can split them without a scheduling.ts change.
 */
export async function detectMachineCapabilityTags(deps: MachineTagProbeDeps = {}): Promise<string[]> {
  const probeDocker = deps.probeDocker ?? defaultProbeDocker(deps.dockerProbeTimeoutMs ?? 1500);
  const tags = ['node'];
  let dockerUp = false;
  try {
    dockerUp = await probeDocker();
  } catch {
    dockerUp = false; // fail-closed: an unresolvable probe means "don't advertise it"
  }
  if (dockerUp) tags.push('docker', 'pg');
  return tags;
}

let cached: Promise<string[]> | null = null;

/**
 * Memoized per-process capability tags — the entry point `writePresence`
 * calls. First caller pays the `docker info` probe cost; every later write
 * this process handles reuses the resolved result.
 */
export function getCachedMachineCapabilityTags(deps: MachineTagProbeDeps = {}): Promise<string[]> {
  if (!cached) cached = detectMachineCapabilityTags(deps);
  return cached;
}

/** Test-only: clear the memoized result so a fresh probe runs next call. */
export function __resetMachineCapabilityTagsCacheForTests(): void {
  cached = null;
}
