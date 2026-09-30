/**
 * `negative-space:scan` — the negative-space miner as a DETERMINISTIC blueprint
 * step (deterministic-blueprints-migration-2026-06-13 P-010 / P-110).
 *
 * The deterministic step kind = a registered typed function (declared
 * args/result I/O) the program-mode spine runs as a checkpointed step — "a
 * defineTool-like registered function" (D-002), NOT a scripting surface. This op
 * WRAPS the shipped miner logic (`runNegativeSpaceMine` — flag + governor + tick,
 * the SAME orchestration the `system:negative-space-mine` routine runs) so the
 * migration reshapes, it does not rewrite (D-003) and stays behavior-neutral
 * (D-004): same flag, same governor budget, same tick.
 *
 * Pure-deterministic (SQL-only, no agent) ⇒ a gateless program-mode pipeline:
 * `blueprints/negative-space/blueprint.yaml` declares one step that fires this op
 * and a `triggers.schedule` cadence; `system:blueprint-run` runs the program.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runNegativeSpaceMine, type NegativeSpaceMineDeps } from '../../negative-space/mine.js';

/** Declared input I/O — the demand fire-bars + window (the routine's payload knobs). */
const args = z.object({
  /** Fire bar: zero-hit count before a query is candidate-worthy. Default 3. */
  minMisses: z.number().int().nonnegative().optional(),
  /** Fire bar: distinct callers required. Default 2. */
  minAgents: z.number().int().nonnegative().optional(),
  /** Per-tick filing cap (0 = mine-only). Default 2. */
  maxPerTick: z.number().int().nonnegative().optional(),
  /** Trailing mining window in days. Default 30. */
  windowDays: z.number().int().positive().optional(),
});

/** Declared output I/O — the tick result (or the gate that skipped it). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off', 'governor-refused']).optional(),
  governorReason: z.string().optional(),
  scanned: z.number().int().optional(),
  demandEntries: z.number().int().optional(),
  filed: z.array(z.string()).optional(),
  declined: z.number().int().optional(),
});

/** Test seam — inject flag/governor/tick deps (mirrors the action's setters). */
let _deps: NegativeSpaceMineDeps | null = null;
export function setNegativeSpaceScanDeps(deps: NegativeSpaceMineDeps | null): void {
  _deps = deps;
}

export const negativeSpaceScanOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'negative-space:scan',
  description:
    'Deterministic step: recompute the zero-hit search demand map and file capped missing-knowledge candidates (negative-space miner).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    // A deterministic capability step declares the substrate it needs; the
    // workspace it mines is the harness's. Absent ⇒ a misconfigured fire — fail
    // loud rather than silently mine the wrong scope.
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('negative-space:scan requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runNegativeSpaceMine({ workspaceId, installSlug, payload: a }, _deps ?? {});
    ctx.log?.(
      `negative-space:scan ran=${outcome.ran}` +
        (outcome.skipReason ? ` skip=${outcome.skipReason}` : '') +
        (outcome.result ? ` scanned=${outcome.result.scanned} demand=${outcome.result.demandEntries} filed=${outcome.result.filed.length}` : ''),
    );
    return {
      ran: outcome.ran,
      skipReason: outcome.skipReason,
      governorReason: outcome.governorReason,
      scanned: outcome.result?.scanned,
      demandEntries: outcome.result?.demandEntries,
      filed: outcome.result?.filed,
      declined: outcome.result?.declined,
    };
  },
};

registerCoordOp(negativeSpaceScanOp);
