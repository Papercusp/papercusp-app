/**
 * `neologism:mine` — the neologism miner as a DETERMINISTIC blueprint step
 * (deterministic-blueprints-migration-2026-06-13 P-011 / P-120).
 *
 * The deterministic step kind = a registered typed function (declared
 * args/result I/O) the program-mode spine runs as a checkpointed step — "a
 * defineTool-like registered function" (D-002), NOT a scripting surface. This op
 * WRAPS the shipped miner logic (`runNeologismMine` — flag + governor + tick,
 * the SAME orchestration the `system:neologism-mine` routine runs) so the
 * migration reshapes, it does not rewrite (D-003) and stays behavior-neutral
 * (D-004): same flag, same governor budget, same tick.
 *
 * Pure-deterministic (SQL/fs-only, no agent) ⇒ a gateless program-mode pipeline:
 * `blueprints/neologism/blueprint.yaml` declares one step that fires this op and
 * a `triggers.schedule` cadence; `system:blueprint-run` runs the program.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runNeologismMine, type NeologismMineDeps } from '../../neologism/mine.js';

/** Declared input I/O — the emergence fire-bars + windows (the routine's payload knobs). */
const args = z.object({
  /** Trailing mining window in days. Default 30. */
  windowDays: z.number().int().positive().optional(),
  /** The "recent" emergence sub-window in days (must be < windowDays). Default 7. */
  recentDays: z.number().int().positive().optional(),
  /** Fire bar: rows mentioning the term in the recent sub-window. Default 4. */
  minRecentMentions: z.number().int().nonnegative().optional(),
  /** Fire bar: distinct speakers over the window. Default 3. */
  minSpeakers: z.number().int().nonnegative().optional(),
  /** Fire bar: recent-rate over smoothed-prior-rate. Default 3. */
  growthFactor: z.number().nonnegative().optional(),
  /** Per-tick filing cap (0 = mine-only). Default 2. */
  maxPerTick: z.number().int().nonnegative().optional(),
});

/** Declared output I/O — the tick result (or the gate that skipped it). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off', 'governor-refused']).optional(),
  governorReason: z.string().optional(),
  scannedRows: z.number().int().optional(),
  insightDocs: z.number().int().optional(),
  terms: z.number().int().optional(),
  overBars: z.number().int().optional(),
  filed: z.array(z.string()).optional(),
  declined: z.number().int().optional(),
});

/** Test seam — inject flag/governor/tick deps (mirrors the action's setters). */
let _deps: NeologismMineDeps | null = null;
export function setNeologismMineDeps(deps: NeologismMineDeps | null): void {
  _deps = deps;
}

export const neologismMineOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'neologism:mine',
  description:
    'Deterministic step: mine coord traffic + the insights corpus for emergent recurring vocabulary with no corresponding primitive and file the capped abstraction-proposal candidates (neologism miner).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    // A deterministic capability step declares the substrate it needs; the
    // workspace it mines is the harness's. Absent ⇒ a misconfigured fire — fail
    // loud rather than silently mine the wrong scope.
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('neologism:mine requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runNeologismMine({ workspaceId, installSlug, payload: a }, _deps ?? {});
    ctx.log?.(
      `neologism:mine ran=${outcome.ran}` +
        (outcome.skipReason ? ` skip=${outcome.skipReason}` : '') +
        (outcome.result
          ? ` rows=${outcome.result.scannedRows} terms=${outcome.result.terms} filed=${outcome.result.filed.length}`
          : ''),
    );
    return {
      ran: outcome.ran,
      skipReason: outcome.skipReason,
      governorReason: outcome.governorReason,
      scannedRows: outcome.result?.scannedRows,
      insightDocs: outcome.result?.insightDocs,
      terms: outcome.result?.terms,
      overBars: outcome.result?.overBars,
      filed: outcome.result?.filed,
      declined: outcome.result?.declined,
    };
  },
};

registerCoordOp(neologismMineOp);
