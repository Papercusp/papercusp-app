/**
 * work_items:judge_redundancy — judge a high-stakes item's replicas + adopt the winner
 * (decentralized-dispatch-scaling P-014). Reuses gym:judge (the frozen Opus grader of record):
 * each complete replica's result is scored on the gym rubric, the highest composite wins
 * (deterministic tie-break), the item is settled to `passed`, and the winner's row is the
 * durable record of which replica was adopted. Needs ≥2 complete replicas.
 *
 * The real `llmCall` is imported lazily (mirrors gym/judge.ts) so registration never
 * pulls the LLM graph; the build→judge→adopt logic lives in the testable judgeRedundancyGroup.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { judgeRedundancyGroup, resolveReplicaPotSlug } from '../../work-item-redundancy';
import { activeWorkspaceId } from '../../workspace-registry';
import type { JudgeLlmCall } from '../../gym/primitives';

const json = (o: unknown) => ({ data: o });

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

export default defineTool({
  name: 'work_items:judge_redundancy',
  profile: 'engineer',
  description:
    "Judge a high-stakes item's redundant replicas + adopt the winner (reuse gym:judge). Scores each complete replica's result on the gym rubric, picks the highest composite (deterministic tie-break), settles the item to passed, marks winner/losers. Needs ≥2 complete replicas. Returns the winner + every replica's score.",
  guidance: {
    when: 'All (or ≥2) replicas of a high-stakes item have recorded their results and you want to pick + adopt the best one. The frozen Opus judge compares them above the per-replica validators.',
    notWhen:
      'Fewer than 2 replicas have recorded (wait for them). A normal exactly-once item (it has no replicas to compare). Scoring a gym optimization run — that is gym:judge directly.',
    chaining:
      'work_items:set_redundancy → claim_replica (×N) → record_replica_result (×N) → work_items:judge_redundancy (adopt winner).',
  },
  // Judging adopts the winner (settles the item) → a write. Like gym:judge, it is a
  // Queen-only optimization surface — the worker-bee is excluded.
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: COORD_ROLES.filter((r) => r !== 'cup'),
  args: z.object({
    id: z.string().min(1).max(120).describe('The high-stakes work-item id.'),
    harness: z.string().min(1).max(80).describe('Harness the work-item lives in.'),
    intent: z.string().optional().describe('The high-level intent (default: the item title + summary).'),
    projectContext: z.string().optional().describe('Repo/project summary the judge weighs gaps against (default: harness + summary).'),
    rubric: rubricArg.describe("A target blueprint's gym.rubric (partial ok; omit → GYM_JUDGE_RUBRIC_V1)."),
  }),
  async handler(args) {
    let llmCall: JudgeLlmCall;
    try {
      llmCall = (await import('../../llm-testing/llm-client')).llmCall as unknown as JudgeLlmCall;
    } catch (e) {
      return json({ ok: false, error: `judge llmCall unavailable: ${e instanceof Error ? e.message : String(e)}` });
    }
    try {
      const workspaceId = activeWorkspaceId();
      const potSlug = await resolveReplicaPotSlug(workspaceId, args.harness);
      const res = await judgeRedundancyGroup(
        { workspaceId, harness: args.harness, potSlug, workItemId: args.id, intent: args.intent, projectContext: args.projectContext, rubric: args.rubric },
        { llmCall },
      );
      if (!res.ok) {
        const msg =
          res.reason === 'item-not-found'
            ? `work-item ${args.id} not found`
            : `need ≥2 complete replicas to judge (have ${res.completeCount ?? 0})`;
        return json({ ok: false, reason: res.reason, error: msg });
      }
      return json(res);
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
});
