/**
 * gym:judge — score one gym run's distilled trace with the frozen Opus judge,
 * using the TARGET blueprint's rubric (D-022). The judge is the only grader of
 * record (D-003): it sits above the target harness's own validator and reasons
 * generically about intent/spec-gaps, code quality, and process correctness,
 * emitting per-dimension scores + a rationale whose weighted composite is the
 * optimization reward.
 *
 * The blueprint port makes the gym a blueprint whose `judge` role calls THIS tool;
 * the target declares its own rubric, which the tool resolves via
 * `rubricFromBlueprintGym` (falling back to GYM_JUDGE_RUBRIC_V1 per field). The
 * real `llmCall` is imported lazily so the module never pulls the LLM
 * graph at registration; the build→call→parse→composite logic lives in the testable
 * `runGymJudge(args, { llmCall })` so it's unit-tested with a fake call (no network).
 *
 * harness-blueprint-orchestration-2026-06-03 P-012 / D-022.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { QUEEN_PLACEMENT_ROLES } from '../coordination/roles';
import { judgeGymRun, rubricFromBlueprintGym, type GymScore, type JudgeLlmCall } from '../../gym/primitives';

/** The (partial) rubric an agent may pass — same shape as a target's blueprint.gym.rubric. */
const rubricArg = z
  .object({
    version: z.string().optional(),
    model: z.string().optional(),
    temperature: z.number().optional(),
    thinkingBudgetTokens: z.number().int().optional(),
    weights: z.record(z.string(), z.number()).optional(),
    dimensions: z.record(z.string(), z.string()).optional(),
  })
  .optional();

export interface GymJudgeArgs {
  intent: string;
  projectContext: string;
  distilledTrace: string;
  rubric?: z.infer<typeof rubricArg>;
}

/**
 * Pure-of-network core: resolve the target's rubric (or V1) and run the frozen
 * judge over the distilled trace. The `llmCall` is injected so a test passes a fake.
 */
export async function runGymJudge(args: GymJudgeArgs, deps: { llmCall: JudgeLlmCall }): Promise<GymScore> {
  // The mapper the judge ROLE uses against a real target resolves a partial rubric
  // (missing fields fall back to V1) — pass the agent's rubric straight through.
  const rubric = rubricFromBlueprintGym(args.rubric ? { rubric: args.rubric } : undefined);
  return judgeGymRun(
    { intent: args.intent, projectContext: args.projectContext, distilledTrace: args.distilledTrace, rubric },
    { llmCall: deps.llmCall },
  );
}

export default defineTool({
  name: 'gym:judge',
  description:
    "Score a gym run's distilled trace with the frozen Opus judge (the only grader of record), using the target blueprint's rubric. Pass {intent, projectContext, distilledTrace, rubric?} where rubric mirrors the target's blueprint.gym.rubric (omit → GYM_JUDGE_RUBRIC_V1). Returns {d1,d2,d3,composite,rationale,judgeModel,rubricHash,costUsd,...}. Reasons ABOVE the harness's own validator (intent/spec-gaps, quality, process).",
  guidance: {
    when: "Scoring a completed gym run for the optimizer — the subjective reward the proposer optimizes. Use the TARGET blueprint's gym.rubric so a coding vs research target is judged on its own dimensions.",
    notWhen: 'Deterministic guardrails (regressions, planted-bug) — that is gym:signals, which the optimizer cannot game. Literal spec conformance — that is the target harness\'s own validator.',
    chaining: 'gym runner → collect+distill trace → gym:judge (rubric from target) → proposer reflects on the rationale.',
    seeAlso: [
      'gym:signals (raw run signals feeding the judgment)',
      'gym:set-gates (the per-harness gates the judgment is measured against)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  // D-002 (bee-capability-expansion-2026-06-08): gym judging is a Queen-only
  // optimization surface — the worker-bee (a COORD_ROLE since local-hive P-011) is
  // EXCLUDED so [...COORD_ROLES] doesn't leak it. Other coord roles are unchanged.
  // Overwatch excluded too (overwatch-role-2026-06-15): it watches+nudges, it is not a
  // gym evaluator — and gym:judge gates on harness:read which the overwatch DOES carry,
  // so the allowlist (not the cap) is what keeps this off its surface.
  agentRoles: QUEEN_PLACEMENT_ROLES,
  args: z.object({
    intent: z.string().min(1).describe('The high-level intent the work should have achieved'),
    projectContext: z.string().describe('Repo/project summary the judge weighs spec-gaps against'),
    distilledTrace: z.string().min(1).describe('The judge-sized distilled trace of the harness run'),
    rubric: rubricArg.describe("The target blueprint's gym.rubric (partial ok; omit for V1)"),
  }),
  async handler(args, ctx) {
    let llmCall: JudgeLlmCall;
    try {
      llmCall = (await import('../../llm-testing/llm-client')).llmCall as unknown as JudgeLlmCall;
    } catch (e) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `judge llmCall unavailable: ${e instanceof Error ? e.message : String(e)}` }) }] };
    }
    try {
      const score = await runGymJudge(args, { llmCall });
      // queen-autonomy P-112: route the gym judge's score+rationale through the
      // disposition log (knowledge-curation). Fire-and-forget + flag-gated.
      const ws = ctx?.workspaceId ?? ctx?.principal?.workspaceId;
      if (ws && ws !== '*') {
        void (async () => {
          try {
            const { recordProactiveDisposition } = await import('../../decision-ledger/disposition');
            await recordProactiveDisposition({
              workspaceId: ws,
              harnessSlug: ctx?.harnessSlug ?? null,
              decisionInput: { action: 'gym:judge', riskTier: 'low', authority: 'system', reversibility: 'reversible' },
              why: typeof score.rationale === 'string' ? score.rationale.slice(0, 1000) : `gym judge composite ${score.composite}`,
              metadata: { composite: score.composite, judgeModel: score.judgeModel, rubricHash: score.rubricHash },
              actorRole: ctx?.role ?? null,
              actorSpawnId: ctx?.spawnId ?? null,
            });
          } catch {
            /* a ledger miss must never break the judge */
          }
        })();
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, score }) }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }] };
    }
  },
});
