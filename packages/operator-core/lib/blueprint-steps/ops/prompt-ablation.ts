/**
 * `prompt:ablation` — the prompt-sedimentology cycle as a DETERMINISTIC blueprint
 * step (deterministic-blueprints-migration-2026-06-13 P-121).
 *
 * One cycle SHADOW-ablates ONE SU-playbook governance rule and replays the
 * llm-testing `su` suite baseline-vs-ablated, scoring the behavioral delta. The two
 * arms are direct `llmCall`s (SUT + sim + judge via the operator runner deps), a
 * GOVERNED replay battery — NOT a fleet agent spawn via spawnInvokeOnce (there is NO
 * spawnInvokeOnce path in lib/ablation — D-009). So prompt-ablation is structurally a
 * DETERMINISTIC pipeline (a single step, like negative-space), NOT a `spawn-roles`
 * hybrid. This op WRAPS the shared `runPromptAblation` orchestration (flag + governor
 * + per-cycle cap + cycle + spend ledger) — same gates, same spend ledger
 * (behavior-neutral, D-004). NEVER mutates a live prompt: the only writes are
 * evidence rows + the governor ledger.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runPromptAblation, type PromptAblationDeps } from '../../ablation/run.js';

/** Declared input I/O — the cycle tunables (the routine's payload knobs). */
const args = z.object({
  /** Restrict to these `su` scenario ids (default: every registered `su` scenario). */
  scenarioIds: z.array(z.string()).optional(),
  /** Matrix repeat per arm (1–5). Default 1. */
  repeat: z.number().int().min(1).max(5).optional(),
  /** Ablate THIS rule instead of the least-recently-ablated rotation pick. */
  ruleKey: z.string().optional(),
  /** D-003 attribution window for the ledger context, days. Default 14. */
  ledgerWindowDays: z.number().positive().optional(),
});

/** Declared output I/O — the cycle result (or the gate that skipped it). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off', 'governor-refused']).optional(),
  governorReason: z.string().optional(),
  runRowId: z.string().optional(),
  ruleKey: z.string().optional(),
  verdict: z.string().optional(),
  costUsd: z.number().optional(),
  capped: z.boolean().optional(),
  replayLegRan: z.boolean().optional(),
});

/** Test seam — inject flag/governor/runner/spend deps (mirrors the action's setters). */
let _deps: PromptAblationDeps | null = null;
export function setPromptAblationOpDeps(deps: PromptAblationDeps | null): void {
  _deps = deps;
}

export const promptAblationOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'prompt:ablation',
  description:
    'Deterministic step: shadow-ablate ONE SU-playbook governance rule and replay the llm-testing `su` suite baseline-vs-ablated, recording the behavioral-delta evidence (prompt sedimentology). Never mutates a live prompt.',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('prompt:ablation requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runPromptAblation({ workspaceId, installSlug, payload: a }, _deps ?? {});
    ctx.log?.(
      `prompt:ablation ran=${outcome.ran}` +
        (outcome.skipReason ? ` skip=${outcome.skipReason}` : '') +
        (outcome.result
          ? ` rule='${outcome.result.ruleKey}' verdict=${outcome.result.score.verdict} ` +
            `cost=$${outcome.result.costUsd.toFixed(2)}${outcome.result.capped ? ' CAPPED' : ''}`
          : ''),
    );
    const r = outcome.result;
    return {
      ran: outcome.ran,
      skipReason: outcome.skipReason,
      governorReason: outcome.governorReason,
      runRowId: r?.runRowId,
      ruleKey: r?.ruleKey,
      verdict: r?.score.verdict,
      costUsd: r?.costUsd,
      capped: r?.capped,
      replayLegRan: r?.replayLegRan,
    };
  },
};

registerCoordOp(promptAblationOp);
