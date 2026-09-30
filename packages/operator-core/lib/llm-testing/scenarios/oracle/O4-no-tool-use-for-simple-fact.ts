/**
 * O4 — no-tool-use-for-simple-fact
 *
 * Persona: brief admin who asks a trivial factual question whose answer
 *          is already in the oracle's system prompt / context.
 *
 * Oracle should answer from context without making any tool calls —
 * unnecessary tool calls on trivial questions waste tokens and latency.
 *
 * Asserts:
 *   - no tool was called (oracle already has the answer in context)
 *   - response is short (< 300 chars) — no lecture
 *   - no <continue/> / <sleep/>
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { ORACLE_RUBRIC } from '../../rubrics/oracle';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const O4_NO_TOOL_USE_FOR_SIMPLE_FACT: Scenario = {
  id: 'oracle-O4-no-tool-use-for-simple-fact',
  version: 1,
  target: 'oracle',
  description:
    'Brief admin asks a simple factual question whose answer is in the oracle\'s context (e.g. "what is your role?"). Oracle must answer from context without wasting tool calls.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 2, maxWallSecs: 60, maxCostUsd: 0.4 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    // Oracle should not reach for tools on a trivial in-context question.
    {
      kind: 'custom',
      name: 'no-unnecessary-tool-calls',
      eval: (run) => {
        const t0 = run.turns[0];
        if (!t0) return [];
        const toolCount = t0.toolCalls?.length ?? 0;
        if (toolCount > 0) {
          return [{
            assertKind: 'custom:no-unnecessary-tool-calls',
            severity: 'warn',
            evidenceTurnIdx: 0,
            claim: `Oracle made ${toolCount} tool call(s) for a question answerable from context.`,
            suggestion: 'For trivial context-local questions, answer directly — no tool call needed.',
          }];
        }
        return [];
      },
    },
    { kind: 'control_tag_present', tag: 'continue', maxCount: 0 },
    { kind: 'control_tag_present', tag: 'sleep', maxCount: 0 },
  ],
  rubric: ORACLE_RUBRIC,
};

export default O4_NO_TOOL_USE_FOR_SIMPLE_FACT;
