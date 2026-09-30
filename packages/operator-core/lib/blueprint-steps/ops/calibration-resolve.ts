/**
 * `calibration:resolve` — the calibration-markets resolution sweep as a
 * DETERMINISTIC blueprint step (deterministic-blueprints-migration-2026-06-13
 * P-041 / bucket A).
 *
 * The deterministic step kind = a registered typed function (declared
 * args/result I/O) the program-mode spine runs as a checkpointed step — "a
 * defineTool-like registered function" (D-002), NOT a scripting surface. This op
 * WRAPS the shipped sweep logic (`runCalibrationResolve` — flag + governor +
 * sweep, the SAME orchestration the `system:calibration-resolve` routine runs)
 * so the migration reshapes, it does not rewrite (D-003) and stays
 * behavior-neutral (D-004): same flag, same governor budget, same sweep.
 *
 * Pure-deterministic (SQL-only, no agent) ⇒ a gateless program-mode pipeline:
 * `blueprints/calibration/blueprint.yaml` declares one step that fires this op
 * and a `triggers.schedule` cadence; `system:blueprint-run` runs the program.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runCalibrationResolve, type CalibrationResolveDeps } from '../../calibration/resolve-loop.js';

/** Declared input I/O — the sweep batch cap (the routine's payload knob). */
const args = z.object({
  /** Per-tick sweep batch cap. Default 200. */
  maxPerTick: z.number().int().positive().optional(),
});

/** Declared output I/O — the sweep result (or the gate that skipped it). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off', 'governor-refused']).optional(),
  governorReason: z.string().optional(),
  matured: z.number().int().optional(),
  resolved: z.number().int().optional(),
  voided: z.number().int().optional(),
  skipped: z.number().int().optional(),
});

/** Test seam — inject flag/governor/sweep deps (mirrors the negative-space op). */
let _deps: CalibrationResolveDeps | null = null;
export function setCalibrationResolveDeps(deps: CalibrationResolveDeps | null): void {
  _deps = deps;
}

export const calibrationResolveOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'calibration:resolve',
  description:
    'Deterministic step: mature open calibration bets against their domain probes, resolving or voiding past the grace window (calibration-markets resolution sweep).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('calibration:resolve requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runCalibrationResolve({ workspaceId, installSlug, payload: a }, _deps ?? {});
    ctx.log?.(
      `calibration:resolve ran=${outcome.ran}` +
        (outcome.skipReason ? ` skip=${outcome.skipReason}` : '') +
        (outcome.result
          ? ` matured=${outcome.result.matured} resolved=${outcome.result.resolved} voided=${outcome.result.voided} skipped=${outcome.result.skipped}`
          : ''),
    );
    return {
      ran: outcome.ran,
      skipReason: outcome.skipReason,
      governorReason: outcome.governorReason,
      matured: outcome.result?.matured,
      resolved: outcome.result?.resolved,
      voided: outcome.result?.voided,
      skipped: outcome.result?.skipped,
    };
  },
};

registerCoordOp(calibrationResolveOp);
