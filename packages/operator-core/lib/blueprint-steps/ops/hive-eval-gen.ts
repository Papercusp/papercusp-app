/**
 * `pot-eval:gen` — the monthly Hive-RUN evaluation benchmark as a deterministic blueprint step
 * (hive-run-evaluation-2026-06-13 HE-07, P-050). The SIBLING of `iq-battery:gen` (D-006/D-011):
 * same hybrid shape (deterministic cadence-decide → governed whole-Hive runs → deterministic score
 * + persist), its OWN slice + tables so Hive-run scores never contaminate the apiary instance trend.
 *
 * Per cadence: decide (owner-budget gate → SHA identity → generation-dedupe), then run + score ONE
 * budget-capped generation of the seeded scenario corpus — whole throwaway Hives graded on outcome
 * quality / efficiency / speed by the HE-06 un-gameable gate, persisted to `hive_eval_scores` (the
 * Learning tab's Benchmark trend reads them). Wraps the shared `runHiveEvalGen` orchestration.
 *
 * NOT a flag/governor loop — the gate is the owner-set `budgetUsd` (refuse if absent; the gym's
 * unattended-spend precedent), so the result is the cadence outcome (refused / skipped / ran /
 * failed). The live whole-Hive runner is owner-gated P-051 (D-011); the default refuses until bound.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runHiveEvalGen, type HiveEvalGenDeps } from '../../pot-eval/gen-loop.js';

/** Declared input I/O — the cadence knobs (the routine's payload). budgetUsd is REQUIRED to run
 *  (absent ⇒ a `refused` outcome — never a defaulted whole-Hive spend). */
const args = z.object({
  /** Hard total-spend ceiling (USD). Absent ⇒ the run is refused (unattended-spend guard). */
  budgetUsd: z.number().positive().optional(),
  /** Scenario ids to run; omitted = the whole seeded corpus. */
  scenarioIds: z.array(z.string()).optional(),
  /** Repeats per scenario (the per-scenario distribution). Default 1. */
  repeats: z.number().int().positive().optional(),
  /** Per-run bee cap (the live cost knob). Default 4. */
  beeCap: z.number().int().positive().optional(),
  /** Plumbing-only mode: run + record + score, skip the optional LLM judge ($0 judge spend). */
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
let _deps: HiveEvalGenDeps | null = null;
export function setHiveEvalGenDeps(deps: HiveEvalGenDeps | null): void {
  _deps = deps;
}

export const hiveEvalGenOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'pot-eval:gen',
  description:
    'Deterministic step: per cadence, run ONE owner-budget-capped SCORED Hive-eval generation (whole-Hive runs over the seeded scenario corpus, graded by the HE-06 un-gameable gate) when the code SHA changed — the Hive-orchestration benchmark pulse, beside its own trend.',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('pot-eval:gen requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runHiveEvalGen({ workspaceId, installSlug, payload: a }, _deps ?? {});
    ctx.log?.(
      `pot-eval:gen action=${outcome.action}` +
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

registerCoordOp(hiveEvalGenOp);
