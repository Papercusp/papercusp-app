/**
 * `graduation:scan` — the graduation-tracker scan as a DETERMINISTIC blueprint
 * step (deterministic-blueprints-migration-2026-06-13 P-046 / bucket A).
 *
 * The deterministic step kind = a registered typed function (declared
 * args/result I/O) the program-mode spine runs as a checkpointed step — "a
 * defineTool-like registered function" (D-002), NOT a scripting surface. This op
 * WRAPS the shipped tracker logic (`runGraduationScan` — flag + governor + tick,
 * the SAME orchestration the `system:graduation-scan` routine runs) so the
 * migration reshapes, it does not rewrite (D-003) and stays behavior-neutral
 * (D-004): same flag, same governor budget, same tick.
 *
 * It FILES AN OWNER REPORT and NEVER auto-edits autoKinds (the widening stays a
 * reviewed policy.ts edit, P-046 / D-008) — preserved exactly via the shared
 * `runGraduationTick`.
 *
 * Pure-deterministic (SQL-only, no agent) ⇒ a gateless program-mode pipeline:
 * `blueprints/graduation/blueprint.yaml` declares one step that fires this op
 * and a `triggers.schedule` cadence; `system:blueprint-run` runs the program.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runGraduationScan, type GraduationScanDeps } from '../../graduation/scan-loop.js';

/** Declared input I/O — the graduation thresholds + windows (the routine's payload knobs). */
const args = z.object({
  /** Clean-pass streak a class must reach to be eligible. Default 5. */
  threshold: z.number().int().positive().optional(),
  /** Recurrence window for a re-capture to break a streak (days). */
  recurrenceWindowDays: z.number().int().positive().optional(),
  /** Evidence lookback for the regression rails (days). Default 90. */
  lookbackDays: z.number().int().positive().optional(),
  /** Cap on owner reports filed per tick. Default 3. */
  maxReportsPerTick: z.number().int().nonnegative().optional(),
  /** Class patterns that may never graduate (always human-gated). */
  neverGraduateClassPatterns: z.array(z.string()).optional(),
  /** Compute + log standings, file nothing (the supervised dry mode). */
  mineOnly: z.boolean().optional(),
});

/** Declared output I/O — the tick result (or the gate that skipped it). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off', 'governor-refused']).optional(),
  governorReason: z.string().optional(),
  classes: z.number().int().optional(),
  eligible: z.array(z.string()).optional(),
  filed: z.array(z.string()).optional(),
  declined: z.number().int().optional(),
});

/** Test seam — inject flag/governor/tick deps (mirrors the negative-space op). */
let _deps: GraduationScanDeps | null = null;
export function setGraduationScanDeps(deps: GraduationScanDeps | null): void {
  _deps = deps;
}

export const graduationScanOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'graduation:scan',
  description:
    'Deterministic step: count per-class clean auto-passes over the outcome rails and file an owner ratification report for any class that crosses the graduation threshold (graduation tracker — never auto-widens autoKinds).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('graduation:scan requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runGraduationScan({ workspaceId, installSlug, payload: a }, _deps ?? {});
    ctx.log?.(
      `graduation:scan ran=${outcome.ran}` +
        (outcome.skipReason ? ` skip=${outcome.skipReason}` : '') +
        (outcome.result
          ? ` classes=${outcome.result.classes} eligible=${outcome.result.eligible.length} filed=${outcome.result.filed.length}`
          : ''),
    );
    return {
      ran: outcome.ran,
      skipReason: outcome.skipReason,
      governorReason: outcome.governorReason,
      classes: outcome.result?.classes,
      eligible: outcome.result?.eligible,
      filed: outcome.result?.filed,
      declined: outcome.result?.declined,
    };
  },
};

registerCoordOp(graduationScanOp);
