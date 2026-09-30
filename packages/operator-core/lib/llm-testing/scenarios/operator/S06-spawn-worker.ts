/**
 * S06 — spawn-worker
 *
 * Persona: patient admin asking the operator to dispatch a worker.
 *
 * Goal: operator emits a <spawn role="worker" .../> tag — or invokes
 *       harness:spawn directly — so a worker agent takes over the work.
 *
 * Covers: B7 (spawn dispatched), B19 (coord:send may also
 *         fire if the operator coordinates beforehand).
 *
 * Deterministic asserts:
 *   - spawn_dispatched (looks at tool_invocations for harness:spawn)
 *   - control_tag_present 'spawn' OR judge cardUsage finding if the
 *     operator instead asks for confirmation via a card (also a valid
 *     UX, just different path)
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S06_SPAWN_WORKER: Scenario = {
  id: 'op-S06-spawn-worker',
  version: 1,
  target: 'operator',
  description:
    'Admin asks the operator to fix a known issue by dispatching a worker. The operator should either emit a <spawn role="worker" feature="..."/> tag or call the harness:spawn tool directly. Asking for clarification first (via a choice card) is also acceptable; the judge scores cardUsage.',
  persona: PATIENT_ADMIN,
  goal: { kind: 'state_reached', predicate: 'worker dispatched or clarification card emitted' },
  caps: { maxTurns: 5, maxWallSecs: 90, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  realWorkspace: true,
  asserts: [
    // Either the spawn fired OR a choice card asked which feature to spawn against.
    // Both are valid; the judge's cardUsage axis scores the choice qualitatively.
    {
      kind: 'custom',
      name: 'spawn-or-choice',
      eval: (run) => {
        const spawnTagged = run.turns.some((t) =>
          t.controlTags.some((c) => c.tag === 'spawn'),
        );
        const spawnCalled = run.toolInvocations.some((t) =>
          /(^|:|__)harness[:_]spawn$|spawn_dispatch/i.test(t.toolName),
        );
        const choiceCard = run.turns.some((t) =>
          t.cards.some((c) => c.kind === 'choice'),
        );
        if (spawnTagged || spawnCalled || choiceCard) return [];
        return [{
          assertKind: 'custom:spawn-or-choice',
          severity: 'error',
          claim: 'Neither a <spawn/> tag, a harness:spawn tool call, nor a choice card was produced.',
          suggestion: 'Operator should dispatch the worker or ask which feature to act on.',
        }];
      },
    },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S06_SPAWN_WORKER;
