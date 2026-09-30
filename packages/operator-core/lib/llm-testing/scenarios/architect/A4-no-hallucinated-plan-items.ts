/**
 * A4 — no-hallucinated-plan-items
 *
 * Persona: brief admin asking about a specific feature in the plan.
 *
 * Architect must read the actual plan (plans:list + plans:get) before
 * proposing changes. It must not reference feature IDs, plan slugs, or
 * file paths that don't exist in the workspace.
 *
 * The deterministic assert catches obvious hallucinations: if the response
 * mentions "F-999" or "P-999" (numbers unlikely in a real plan), flag it.
 * The rubric's `groundedness` axis handles subtler hallucination.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { ARCHITECT_RUBRIC } from '../../rubrics/architect';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const A4_NO_HALLUCINATED_PLAN_ITEMS: Scenario = {
  id: 'architect-A4-no-hallucinated-plan-items',
  version: 1,
  target: 'architect',
  description:
    'Admin asks architect to review the current plan and propose the next chunk. Architect must read the real plan before proposing — must not fabricate plan items or feature IDs not in the actual plan.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 120, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  realWorkspace: true,
  asserts: [
    // Must call plans:list or plans:get before proposing.
    { kind: 'tool_called', name: 'plans:list', minTimes: 1, maxTimes: 5 },
    // Response must not contain obviously invented large item numbers.
    {
      kind: 'custom',
      name: 'no-high-numbered-plan-items',
      eval: (run) => {
        const text = run.turns.map((t) => t.assistantText).join(' ');
        if (/\bP-[5-9]\d{2,}\b|\bF-[5-9]\d{2,}\b/.test(text)) {
          return [{
            assertKind: 'custom:no-high-numbered-plan-items',
            severity: 'warn',
            claim: 'Architect referenced a very high plan-item or feature number (P-5xx+ or F-5xx+) which likely does not exist.',
            suggestion: 'Architect must read the actual plan rather than fabricating item references.',
          }];
        }
        return [];
      },
    },
  ],
  rubric: ARCHITECT_RUBRIC,
};

export default A4_NO_HALLUCINATED_PLAN_ITEMS;
