/**
 * S12b — tool-error-injected (deterministic variant of S12)
 *
 * Where S12 asks for a non-existent entity (relying on the brain to
 * trigger an error naturally), S12b uses the brain-subprocess override
 * (plan §10.4) to force `harness:status` to return an error on every
 * call. The brain's first lookup attempt fails; the assertion catches
 * any loop.
 *
 * The override is keyed by runId via the framework's dispatch-override
 * registry — every nested call the brain makes during operator:converse
 * sees the same failure, deterministically.
 *
 * Together S12 + S12b cover the same behavior (B21 tool-error recovery)
 * from two angles: natural error path + deterministic injection.
 */

import { makeStaticOverride } from '@papercusp/testing-shell/llm';
import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S12B_TOOL_ERROR_INJECTED: Scenario = {
  id: 'op-S12b-tool-error-injected',
  version: 1,
  target: 'operator',
  description:
    'Admin asks a routine question that would normally trigger harness:status. The framework injects a synthetic error response for that tool; the brain must NOT loop on it and should surface the failure or pivot.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 90, maxCostUsd: 1.2 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  // Inject errors for the common harness lookup tools. Anything else
  // passes through to the real handler.
  toolOverride: makeStaticOverride({
    'harness:status': { error: 'PG unavailable (synthetic — llm-testing S12b)' },
    'mcp__agentmcp__harness:status': { error: 'PG unavailable (synthetic — llm-testing S12b)' },
    'features:get': { error: 'PG unavailable (synthetic — llm-testing S12b)' },
    'mcp__agentmcp__features:get': { error: 'PG unavailable (synthetic — llm-testing S12b)' },
  }),
  asserts: [
    {
      kind: 'custom',
      name: 'no-loop-on-failed-tool',
      eval: (run) => {
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
              suggestion: 'After a tool returns an error, the brain should change approach or surface the error.',
            }];
          }
        }
        return [];
      },
    },
    // The override should fire at least once — confirms the plumbing
    // is wired. If zero overridden calls were recorded, either the
    // brain didn't try to look up the harness, or the override
    // registry didn't connect through.
    {
      kind: 'custom',
      name: 'override-fired-at-least-once',
      eval: (run) => {
        const overridden = run.turns
          .flatMap((t) => t.toolCalls)
          .filter((tc) =>
            tc.name === 'harness:status'
              || tc.name === 'mcp__agentmcp__harness:status'
              || tc.name === 'features:get'
              || tc.name === 'mcp__agentmcp__features:get',
          );
        if (overridden.length === 0) {
          return [{
            assertKind: 'custom:override-fired-at-least-once',
            severity: 'warn',
            claim: 'Brain never attempted a lookup that would have hit the injected override.',
            suggestion: 'Persona prompt may not be steering toward harness lookup — adjust the scenario goal text.',
          }];
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

export default S12B_TOOL_ERROR_INJECTED;
