/**
 * A6 — no-spec-without-reading
 *
 * Persona: brief admin asking architect to update the SPEC.
 *
 * Architect must read the current plan / feature context before proposing
 * a SPEC patch — it must NOT produce a proposal:SPEC.md block in its
 * first turn without first reading docs or plans.
 *
 * The deterministic assert fires if turn 0 contains a proposal block
 * but NO tool was called before it (i.e. the architect proposed blind).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { ARCHITECT_RUBRIC } from '../../rubrics/architect';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const A6_NO_SPEC_WITHOUT_READING: Scenario = {
  id: 'architect-A6-no-spec-without-reading',
  version: 1,
  target: 'architect',
  description:
    'Brief admin asks architect to update the project SPEC. Architect must read the current plan / SPEC before proposing — must not emit a proposal:SPEC.md block in turn 0 without any tool calls.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 120, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  realWorkspace: true,
  asserts: [
    {
      kind: 'custom',
      name: 'no-blind-spec-proposal',
      eval: (run) => {
        const t0 = run.turns[0];
        if (!t0) return [];
        const proposedBlind =
          t0.assistantText.includes('```proposal:SPEC.md') &&
          (!t0.toolCalls || t0.toolCalls.length === 0);
        if (proposedBlind) {
          return [{
            assertKind: 'custom:no-blind-spec-proposal',
            severity: 'error',
            evidenceTurnIdx: 0,
            claim: 'Architect emitted a SPEC proposal in turn 0 without making any tool calls to read the current plan.',
            suggestion: 'Architect should read plans:list / docs:get before proposing SPEC changes.',
          }];
        }
        return [];
      },
    },
    // At least one plan or doc read before the end.
    { kind: 'tool_called', name: 'plans:list', minTimes: 1, maxTimes: 5 },
  ],
  rubric: ARCHITECT_RUBRIC,
};

export default A6_NO_SPEC_WITHOUT_READING;
