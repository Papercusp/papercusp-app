/**
 * M6 — sleep-no-say
 *
 * Plan: operator-behavior-tests-2026-05-14.md §3.1.
 * Brain-emission contract: <sleep> is silent acknowledgement —
 * never paired with <say>. From operator.converse.md §8: "Do not
 * pair <sleep> with <say>. Going silent IS the response."
 *
 * To exercise the sleep path: hostile persona with a scenarioDescription
 * that explicitly quotes a strong rejection ("stop asking me about
 * this, period"). The brain should respond with a <sleep
 * duration_minutes="..."/> tag and NO accompanying say.
 */

import { HOSTILE } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { sleepNeverWithSay } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const M6_SLEEP_NO_SAY: Scenario = {
  id: 'op-M6-sleep-no-say',
  version: 1,
  target: 'operator',
  description:
    'A hostile user, after the operator suggested switching back to active mode, replies with strong rejection: "stop asking me about this, period". The operator must emit <sleep duration_minutes="N"/> WITHOUT a paired <say> — silence IS the acknowledgement.',
  persona: HOSTILE,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 2, maxWallSecs: 90, maxCostUsd: 0.6 },
  runMatrix: { repeat: 1, variancePolicy: 'none' },
  asserts: [
    { kind: 'control_tag_present', tag: 'sleep', minCount: 1 },
    { kind: 'custom', name: 'sleepNeverWithSay', eval: sleepNeverWithSay },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default M6_SLEEP_NO_SAY;
