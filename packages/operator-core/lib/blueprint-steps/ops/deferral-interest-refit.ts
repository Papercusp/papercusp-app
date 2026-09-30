/**
 * `deferral-interest:refit` — the deferral-interest pricing refit as a
 * DETERMINISTIC blueprint step (deterministic-blueprints-migration-2026-06-13
 * P-042 / bucket A).
 *
 * The deterministic step kind = a registered typed function (declared
 * args/result I/O) the program-mode spine runs as a checkpointed step — "a
 * defineTool-like registered function" (D-002), NOT a scripting surface. This op
 * WRAPS the shipped refit logic (`runDeferralInterestRefitGated` — flag +
 * governor + tick, the SAME orchestration the `system:deferral-interest-refit`
 * routine runs) so the migration reshapes, it does not rewrite (D-003) and stays
 * behavior-neutral (D-004): same flag, same governor budget, same tick.
 *
 * Pure-deterministic (SQL + pure math, no agent) ⇒ a gateless program-mode
 * pipeline: `blueprints/deferral-interest/blueprint.yaml` declares one step that
 * fires this op and a `triggers.schedule` cadence; `system:blueprint-run` runs
 * the program. The refit takes no payload tunables (full-corpus recompute).
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import {
  runDeferralInterestRefitGated,
  type DeferralRefitGateDeps,
} from '../../deferral-interest/refit-loop.js';

/** Declared input I/O — the refit is a full-corpus recompute, no tunables. */
const args = z.object({});

/** Declared output I/O — the refit result (or the gate that skipped it). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off', 'governor-refused']).optional(),
  governorReason: z.string().optional(),
  candidates: z.number().int().optional(),
  deferrals: z.number().int().optional(),
  decided: z.number().int().optional(),
  stillOpen: z.number().int().optional(),
  globalRatePerWeek: z.number().optional(),
  weak: z.boolean().optional(),
});

/** Test seam — inject flag/governor/tick deps (mirrors the negative-space op). */
let _deps: DeferralRefitGateDeps | null = null;
export function setDeferralRefitGateDeps(deps: DeferralRefitGateDeps | null): void {
  _deps = deps;
}

export const deferralInterestRefitOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'deferral-interest:refit',
  description:
    'Deterministic step: backfill realized deferral costs from history and re-fit the learned deferral-pricing model the queue ranker reads (deferral-interest refit).',
  argsSchema: args,
  resultSchema: result,
  async run(_a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('deferral-interest:refit requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runDeferralInterestRefitGated({ workspaceId, installSlug }, _deps ?? {});
    ctx.log?.(
      `deferral-interest:refit ran=${outcome.ran}` +
        (outcome.skipReason ? ` skip=${outcome.skipReason}` : '') +
        (outcome.result
          ? ` deferrals=${outcome.result.deferrals} decided=${outcome.result.decided} rate/wk=${outcome.result.globalRatePerWeek}`
          : ''),
    );
    return {
      ran: outcome.ran,
      skipReason: outcome.skipReason,
      governorReason: outcome.governorReason,
      candidates: outcome.result?.candidates,
      deferrals: outcome.result?.deferrals,
      decided: outcome.result?.decided,
      stillOpen: outcome.result?.stillOpen,
      globalRatePerWeek: outcome.result?.globalRatePerWeek,
      weak: outcome.result?.weak,
    };
  },
};

registerCoordOp(deferralInterestRefitOp);
