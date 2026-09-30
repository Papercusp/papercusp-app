/**
 * S12 — tool-error-recovery
 *
 * Persona: precise admin who asks the operator to look up something
 * that doesn't exist ("show me issue I-99999-does-not-exist").
 *
 * The brain naturally calls a lookup tool (work_items:get or
 * harness:status) which returns an error. The test checks that the
 * brain RECOVERS — does not loop on the same failing call, and
 * surfaces a useful response.
 *
 * Covers: B21 (tool error surfaces, brain recovers).
 *
 * The plan's original S12 design used `transport: 'http-sse'` +
 * ToolDispatchOverride to force the error. That requires
 * brain-subprocess override plumbing (still a follow-up). The natural-
 * error path lands the scenario today and proves the recovery
 * behavior. When the override path lands, S12 can switch to the
 * deterministic injection while keeping the same asserts.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S12_TOOL_ERROR_RECOVERY: Scenario = {
  id: 'op-S12-tool-error-recovery',
  version: 1,
  target: 'operator',
  description:
    "Admin asks for a feature/issue that doesn't exist. The lookup tool fails. The operator should NOT loop on the same call — it should surface the error and offer alternatives.",
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 90, maxCostUsd: 1.2 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    {
      kind: 'custom',
      name: 'no-loop-on-failed-tool',
      eval: (run) => {
        // Count consecutive identical tool calls. If the same tool with
        // the same args appears in 3+ consecutive turns, the brain is
        // looping on a failure.
        const seen: Array<{ name: string; key: string }> = [];
        for (const turn of run.turns) {
          for (const tc of turn.toolCalls) {
            seen.push({ name: tc.name, key: `${tc.name}:${stableKey(tc.input)}` });
          }
        }
        for (let i = 0; i + 2 < seen.length; i++) {
          if (seen[i].key === seen[i + 1].key && seen[i + 1].key === seen[i + 2].key) {
            return [{
              assertKind: 'custom:no-loop-on-failed-tool',
              severity: 'error',
              claim: `Tool '${seen[i].name}' called 3+ times with identical args — brain is looping on a failure.`,
              suggestion: 'After a tool returns an error, the brain should change approach or surface the error to the user.',
            }];
          }
        }
        return [];
      },
    },
  ],
  rubric: OPERATOR_RUBRIC,
};

function stableKey(v: unknown): string {
  try {
    return JSON.stringify(v, Object.keys((v ?? {}) as object).sort());
  } catch {
    return String(v);
  }
}

export default S12_TOOL_ERROR_RECOVERY;
