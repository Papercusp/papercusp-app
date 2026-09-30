/**
 * announce-volume-hook.ts — the FORWARD HOOK for the hive-directory
 * announce-volume scenario (p2p-performance-suite-2026-06-07 P-015).
 *
 * WHY THIS IS A HOOK, NOT A SCENARIO YET. Every other scenario in this suite
 * measures a curve that scales with *harness* size (history, peer-count within
 * one harness). The [[p2p-hive-directory-2026-06-06]] directory is different: a
 * GLOBAL announce topic every node on the network joins, so its load scales with
 * the *network* size — a node processes an announce from every other node, not
 * just its harness-mates. That is a distinct curve (announce-processing volume
 * and dedup/verify cost vs total-network N), and it can only be measured once the
 * directory's global-topic substrate exists.
 *
 * Audited 2026-06-07: that substrate does NOT exist yet (no global announce
 * topic; `derive-swarm-topic.ts` derives PER-HARNESS topics, `announce.ts`
 * signs/verifies a per-harness announce). The directory plan's D-001..D-003 are
 * still un-ratified. So writing a real scenario now would mean guessing an API —
 * the wrong move. Instead this hook:
 *   1. documents exactly what the scenario will measure (below);
 *   2. probes for the directory capability (`hiveDirectoryReady()`); and
 *   3. exposes `announceVolumeScenario()`, which runs once the capability lands
 *      and otherwise throws a clear, actionable PENDING error.
 * The colocated test asserts the hook is present and currently pending — it
 * starts demanding activation the moment the directory module appears (the
 * durable reminder), so the hook can't silently rot.
 *
 * ACTIVATION (when hive-directory ships): implement `hiveDirectoryReady()` to
 * detect the real module, fill `announceVolumeScenario()` against its global-topic
 * API (provision K frames via bench-frames, each joins the global directory topic,
 * measure announce-processing rate + per-announce verify cost + dedup hit-rate as
 * K grows — emit a tier:3 PerfArtifact with `scenario:'tier3.announce-volume'` so
 * it overlays the rest), add `'announce-volume'` to the Tier3SuiteOpts scenario
 * union, and flip the test from `.pending` to a real assertion.
 */

import type { PerfArtifact } from '../../sync/hyperbee/perf/artifact';
import type { PeerLauncher } from './remote-peer';

/** What the announce-volume scenario will measure once the directory exists. */
export const ANNOUNCE_VOLUME_DESIGN = {
  scenarioId: 'tier3.announce-volume',
  blockedOnPlan: 'p2p-hive-directory-2026-06-06',
  /** The axis that makes this distinct from every harness-scoped scenario. */
  scalingAxis: 'total-network-node-count (NOT harness size)',
  metrics: [
    'announceProcessedPerSec', // ops/sec — announces verified+deduped per node as N grows
    'announceVerifyMs', // ms — per-announce signature+binding verify cost
    'directoryConvergenceMs', // ms — time for a new hive to appear in every node's directory view
    'dedupHitRate', // count — re-seen announces dropped (network gossip amplification)
  ],
} as const;

/**
 * Capability probe: does the hive-directory global-topic substrate exist yet?
 * Returns false today. ACTIVATION: replace the body with a real detection (e.g.
 * `import('../../sync/hyperbee/directory').then(m => !!m.deriveDirectoryTopic)`).
 */
export function hiveDirectoryReady(): boolean {
  return false;
}

export interface AnnounceVolumeOpts {
  launcher: PeerLauncher;
  /** Frames all join the GLOBAL directory topic (vs a per-harness topic). */
  nodeCount: number;
  log?: (line: string) => void;
}

/** Raised when the scenario is invoked before the directory substrate exists. */
export class AnnounceVolumePendingError extends Error {
  constructor() {
    super(
      `tier3.announce-volume is a FORWARD HOOK (P-015) blocked on ${ANNOUNCE_VOLUME_DESIGN.blockedOnPlan}: ` +
        `the hive-directory global announce topic does not exist yet. Implement hiveDirectoryReady() + ` +
        `announceVolumeScenario() when that plan ships (see announce-volume-hook.ts header).`,
    );
    this.name = 'AnnounceVolumePendingError';
  }
}

/**
 * Run the announce-volume scenario. Throws `AnnounceVolumePendingError` until the
 * hive-directory substrate exists. Wired into the Tier-3 suite the same way as the
 * other scenarios once active.
 */
export async function announceVolumeScenario(_opts: AnnounceVolumeOpts): Promise<PerfArtifact> {
  if (!hiveDirectoryReady()) throw new AnnounceVolumePendingError();
  // ACTIVATION: provision `nodeCount` frames, each joins the global directory
  // topic, drive hive create/announce, measure ANNOUNCE_VOLUME_DESIGN.metrics,
  // and return a tier:3 PerfArtifact { scenario: 'tier3.announce-volume', … }.
  throw new AnnounceVolumePendingError();
}
