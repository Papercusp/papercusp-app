/**
 * `iq-battery:gen` — the monthly IQ-battery benchmark as a HYBRID deterministic
 * blueprint step (deterministic-blueprints-migration-2026-06-13, bucket A / D-013).
 *
 * Per cadence: decide (owner-budget gate → SHA identity → generation-dedupe), then
 * run ONE budget-capped gen-0 battery — solver/judge bees spawned via
 * `spawnAgentInHarness → cup:spawn → spawnInvokeOnce` (the governed chokepoint,
 * so D-005 holds), then persist beside gen-0 in the beekeeper_* tables. This op
 * WRAPS the shared `runIqBatteryGen` orchestration (the SAME cadence-tick + gen-0
 * runner the bespoke routine ran) — behavior-neutral (D-004). The bee spawn stays
 * INTERNAL to the op (Option A, like regret), NOT a `spawn-roles` step: bees take a
 * corpus-case brief, not a harness role/persona (D-013).
 *
 * NOT a flag/governor loop — the gate is the owner-set `budgetUsd` (refuse if
 * absent; the gym's unattended-spend precedent), so the result is the cadence
 * outcome (refused / skipped / ran / failed), not a flag/governor skip.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runIqBatteryGen, type IqBatteryGenDeps } from '../../iq-battery/gen-loop.js';

/** Declared input I/O — the cadence knobs (the routine's payload). budgetUsd is REQUIRED
 *  to run (absent ⇒ a `refused` outcome — never a defaulted spend). */
const args = z.object({
  /** Hard total-spend ceiling (USD). Absent ⇒ the run is refused (unattended-spend guard). */
  budgetUsd: z.number().positive().optional(),
  /** Cases administered per variant. Default 1. */
  casesPerVariant: z.number().int().positive().optional(),
  /** Repeats per cell. Default 1. */
  repeats: z.number().int().positive().optional(),
  /** Plumbing-only mode: administer + persist, skip the judge ($0 judge spend). */
  dryRun: z.boolean().optional(),
});

/** Declared output I/O — the cadence outcome (discriminated `action` + its fields). */
const result = z.object({
  action: z.enum(['refused', 'skipped', 'ran', 'failed']),
  codeSha: z.string().optional(),
  capUsd: z.number().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

/** Test seam — inject runBattery/currentCodeSha/generationExists/log (no PG/git/LLM). */
let _deps: IqBatteryGenDeps | null = null;
export function setIqBatteryGenDeps(deps: IqBatteryGenDeps | null): void {
  _deps = deps;
}

export const iqBatteryGenOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'iq-battery:gen',
  description:
    'Deterministic step: per cadence, run ONE owner-budget-capped IQ-battery generation (solver/judge bees via the governed chokepoint) when the code SHA changed, beside gen-0 in the beekeeper trend (the benchmark pulse).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('iq-battery:gen requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runIqBatteryGen({ workspaceId, installSlug, payload: a }, _deps ?? {});
    ctx.log?.(
      `iq-battery:gen action=${outcome.action}` +
        ('codeSha' in outcome ? ` sha=${outcome.codeSha}` : '') +
        (outcome.action === 'ran' ? ` cap=$${outcome.capUsd}` : ''),
    );
    return {
      action: outcome.action,
      codeSha: 'codeSha' in outcome ? outcome.codeSha : undefined,
      capUsd: outcome.action === 'ran' ? outcome.capUsd : undefined,
      reason: outcome.action === 'refused' || outcome.action === 'skipped' ? outcome.reason : undefined,
      error: outcome.action === 'failed' ? outcome.error : undefined,
    };
  },
};

registerCoordOp(iqBatteryGenOp);
