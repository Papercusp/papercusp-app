import { dreamCallOwnerId } from '../../dream/dream-cycle.ts';

const phases = ['generation', 'control-a', 'control-b', 'review'] as const;
type Phase = typeof phases[number];
type Report = { stageTelemetry?: { ownerId?: string; recent?: Array<{ ownerId?: string; [key: string]: unknown }>; [key: string]: unknown } };

/** One read per dispatched phase, after restoration. Missing/evicted evidence is
 * explicitly unknown, never a claim that admission or generation did not happen. */
export async function captureStudyTiming(
  scope: { workspaceId: string; potSlug: string },
  runs: Array<{ runId: string; phases: string[] }>,
  deps: { report: (ownerId: string) => Promise<unknown>; log: (entry: unknown) => Promise<void> },
): Promise<void> {
  for (const run of runs) {
    for (const phase of phases.filter((p) => run.phases.includes(p))) {
      const ownerId = dreamCallOwnerId(scope, run.runId, phase as Phase);
      const base = { phase: 'gateway-timing', runId: run.runId, callPhase: phase, ownerId };
      try {
        const report = await deps.report(ownerId) as Report;
        const stage = report?.stageTelemetry;
        const valid = stage?.ownerId === ownerId && Array.isArray(stage.recent) &&
          stage.recent.length > 0 && stage.recent.every((row) => row.ownerId === ownerId);
        await deps.log(valid
          ? { ...base, status: 'captured', stageTelemetry: stage }
          : { ...base, status: 'unavailable', reason: 'No complete owner-matched retained timeline; timing cause remains unknown.' });
      } catch (error) {
        await deps.log({ ...base, status: 'unavailable', reason: String(error) });
      }
    }
  }
}
