/**
 * mesh-outcome.ts — how a proc-mesh formation failure is classified and
 * recorded (EI-116).
 *
 * `spawnProcMesh` forms a writer + N readers and resolves only once every
 * reader has admitted the writer's log. On a Tier-1 loopback that is a hard
 * precondition: a failure to form is a genuine harness fault and SHOULD throw.
 * But the Tier-2 netem driver runs the SAME mesh through a deliberately
 * impaired link (delay/jitter/loss up to 2%), where a mesh that cannot form
 * within the budget is a MEASURED OUTCOME of the profile, not a defect — yet it
 * used to propagate to netem-inner's fatal handler and crash the whole Tier-2
 * sweep, auto-filing a noise bug every weekly run.
 *
 * This module makes the failure typed (`MeshFormationError`) so a caller can
 * tell the two cases apart, and gives the netem driver a way to fold a
 * formation failure into a `did-not-form` artifact (`resolveNetemFailure`) so
 * the cell is recorded and the sweep continues.
 */

import { ScenarioMeter } from './metrics';
import type { PerfArtifact } from './artifact';

/**
 * Thrown by `spawnProcMesh` when the writer never becomes ready, or a reader
 * never admits the writer, within the mesh-formation budget. Typed so callers
 * can distinguish an expected-under-impairment formation failure (Tier-2 netem:
 * record it) from any other error (a real fault: stays fatal).
 */
export class MeshFormationError extends Error {
  constructor(
    message: string,
    /** The peer that failed to form (writer = 0). Undefined for a writer-never-ready failure. */
    readonly peerIndex?: number,
  ) {
    super(message);
    this.name = 'MeshFormationError';
  }
}

/**
 * Build the artifact for a netem cell whose mesh never formed under the
 * impaired link. No sync ran, so there are no metrics and the host-event-loop
 * SLO is not meaningful (sloPassed = null); the artifact exists to RECORD the
 * cell (`params.meshFormed = false` + a note) rather than crash the sweep.
 *
 * Convergence is likewise left UNMEASURED (`convergence: null` — the meter is
 * never told to expect readers), for the same reason the SLO is: no reader ever
 * got the chance to catch up, so there is no convergence observation to report.
 * `null` reads as "not measured", never as a pass — `collectConvergenceViolations`
 * only ever fires on an explicit `false` (EI-20576392705164447).
 */
export function meshDidNotFormArtifact(opts: {
  scenario: string;
  tier: 1 | 2 | 3;
  params: Record<string, string | number | boolean>;
  reason: string;
}): PerfArtifact {
  const meter = new ScenarioMeter({
    scenario: opts.scenario,
    tier: opts.tier,
    params: { ...opts.params, meshFormed: false },
  });
  meter.note(`mesh did not form under this profile: ${opts.reason}`);
  const artifact = meter.finish();
  // No sync work ran on this cell — the loop-lag verdict says nothing useful.
  artifact.sloPassed = null;
  return artifact;
}

/**
 * Decide what a netem cell does with a thrown error: a `MeshFormationError` is
 * folded into a did-not-form artifact (recorded, sweep continues); anything
 * else stays fatal (the cell crashes and is reported). The pure core of
 * netem-inner's catch — see EI-116.
 */
export function resolveNetemFailure(
  e: unknown,
  ctx: { scenario: string; tier: 1 | 2 | 3; params: Record<string, string | number | boolean> },
): { kind: 'artifact'; artifact: PerfArtifact } | { kind: 'fatal'; message: string } {
  if (e instanceof MeshFormationError) {
    return { kind: 'artifact', artifact: meshDidNotFormArtifact({ ...ctx, reason: e.message }) };
  }
  return { kind: 'fatal', message: e instanceof Error ? (e.stack ?? e.message) : String(e) };
}
