/**
 * `fleet-ekg:scan` — the Fleet EKG as a DETERMINISTIC blueprint step
 * (deterministic-blueprints-migration-2026-06-13 P-030 / P-120).
 *
 * The deterministic step kind = a registered typed function (declared
 * args/result I/O) the program-mode spine runs as a checkpointed step — "a
 * defineTool-like registered function" (D-002), NOT a scripting surface. This op
 * WRAPS the shipped EKG logic (`runFleetEkgScan` — flag + governor + tick, the
 * SAME orchestration the `system:fleet-ekg-scan` routine runs) so the migration
 * reshapes, it does not rewrite (D-003) and stays behavior-neutral (D-004): same
 * flag, same governor budget, same tick.
 *
 * Pure-deterministic (SQL-only, no agent) ⇒ a gateless program-mode pipeline:
 * `blueprints/fleet-ekg/blueprint.yaml` declares one step that fires this op and
 * a `triggers.schedule` cadence; `system:blueprint-run` runs the program.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runFleetEkgScan, type FleetEkgScanDeps } from '../../fleet-ekg/run.js';

/** Declared input I/O — the detection windows + thresholds (the routine's payload knobs). */
const args = z.object({
  /** How far back to (re)embed sessions, days. Default 3. */
  embedDays: z.number().positive().optional(),
  /** Shift-window size, hours. Default 24. */
  windowHours: z.number().positive().optional(),
  /** Baseline size preceding the window, days. Default 7. */
  baselineDays: z.number().positive().optional(),
  /** Per-session event floor. Default MIN_SESSION_EVENTS. */
  minEvents: z.number().positive().optional(),
  /** Drift minimum window cohort size. */
  minWindowSessions: z.number().positive().optional(),
  /** Drift minimum baseline cohort size. */
  minBaselineSessions: z.number().positive().optional(),
  /** PSI moderate / major thresholds. */
  psiModerate: z.number().positive().optional(),
  psiMajor: z.number().positive().optional(),
  /** JSD moderate / major thresholds. */
  jsdModerate: z.number().positive().optional(),
  jsdMajor: z.number().positive().optional(),
});

/** Declared output I/O — the tick result (or the gate that skipped it). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off', 'governor-refused']).optional(),
  governorReason: z.string().optional(),
  embedded: z.number().int().optional(),
  skippedSmall: z.number().int().optional(),
  status: z.enum(['ok', 'insufficient-window', 'insufficient-baseline']).optional(),
  windowSessions: z.number().int().optional(),
  baselineSessions: z.number().int().optional(),
  findings: z.number().int().optional(),
  attributed: z.number().int().optional(),
  unattributable: z.number().int().optional(),
  alarmed: z.number().int().optional(),
});

/** Test seam — inject flag/governor/tick deps (mirrors the action's setters). */
let _deps: FleetEkgScanDeps | null = null;
export function setFleetEkgScanDeps(deps: FleetEkgScanDeps | null): void {
  _deps = deps;
}

export const fleetEkgScanOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'fleet-ekg:scan',
  description:
    'Deterministic step: embed recent agent sessions into behavioral vectors, detect fleet-wide distribution shifts vs the trailing baseline, attribute against the behavior-change ledger, and alarm unattributable MAJOR shifts (Fleet EKG).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    // A deterministic capability step declares the substrate it needs; the
    // workspace it scans is the harness's. Absent ⇒ a misconfigured fire — fail
    // loud rather than silently scan the wrong scope.
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('fleet-ekg:scan requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runFleetEkgScan({ workspaceId, installSlug, payload: a }, _deps ?? {});
    ctx.log?.(
      `fleet-ekg:scan ran=${outcome.ran}` +
        (outcome.skipReason ? ` skip=${outcome.skipReason}` : '') +
        (outcome.result
          ? ` embedded=${outcome.result.embedded} status=${outcome.result.status} findings=${outcome.result.findings} alarmed=${outcome.result.alarmed}`
          : ''),
    );
    return {
      ran: outcome.ran,
      skipReason: outcome.skipReason,
      governorReason: outcome.governorReason,
      embedded: outcome.result?.embedded,
      skippedSmall: outcome.result?.skippedSmall,
      status: outcome.result?.status,
      windowSessions: outcome.result?.windowSessions,
      baselineSessions: outcome.result?.baselineSessions,
      findings: outcome.result?.findings,
      attributed: outcome.result?.attributed,
      unattributable: outcome.result?.unattributable,
      alarmed: outcome.result?.alarmed,
    };
  },
};

registerCoordOp(fleetEkgScanOp);
