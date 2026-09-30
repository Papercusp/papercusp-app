/**
 * M7 — after-says-ready-options (criticality:high)
 *
 * Plan: operator-behavior-tests-2026-05-14.md §3.1.
 * Brain-emission contract: after `user_says_ready` trigger, the
 * brain surfaces 2–3 concrete next-step options (card OR short
 * prose list). From operator.tools.md → Surfacing suggestions.
 *
 * Trigger setup: scripted user_says_ready at turn 0 (bypasses
 * sim-user). SUT receives empty messages + trigger='user_says_ready'.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC_HIGH_CRITICALITY } from '../../rubrics/operator';
import { optionsCountWithinBounds } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const M7_AFTER_SAYS_READY_OPTIONS: Scenario = {
  id: 'op-M7-after-says-ready-options',
  version: 1,
  target: 'operator',
  description:
    'On user_says_ready (the user said "ready"/"next"/"go", or the silence-nudge Ready card was answered), the operator surfaces 2-3 concrete next-step options — either via chat:ask_choice card or as a short numbered prose list. Not 1 (skip the question), not 4+ (overwhelm).',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 1, maxWallSecs: 60, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  triggers: [{ on: 'after_turn', fire: 'user_says_ready', param: 0 }],
  realWorkspace: true,
  asserts: [
    {
      kind: 'custom',
      name: 'optionsCountWithinBounds(2,3)',
      eval: optionsCountWithinBounds(2, 3),
    },
  ],
  rubric: OPERATOR_RUBRIC_HIGH_CRITICALITY,
};

export default M7_AFTER_SAYS_READY_OPTIONS;
