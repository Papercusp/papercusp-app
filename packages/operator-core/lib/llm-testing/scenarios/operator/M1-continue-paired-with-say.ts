/**
 * M1 — continue-paired-with-say
 *
 * Plan: operator-behavior-tests-2026-05-14.md §3.1.
 * Brain-emission contract: every <continue/> turn carries a non-empty
 * <say>. From operator.converse.md §6: "<continue/> MUST be paired
 * with a <say> that narrates what you're about to do next. Never
 * emit <continue/> silently — the user must see progress."
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { continueAlwaysPairedWithSay } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const M1_CONTINUE_PAIRED_WITH_SAY: Scenario = {
  id: 'op-M1-continue-paired-with-say',
  version: 1,
  target: 'operator',
  description:
    'A patient admin asks the operator to do a multi-step thing ("walk me through the sheets harness then summarize what\'s blocked"). The operator should chain turns with <continue/> AND narrate each step via <say>. Every <continue/> turn must include a non-empty <say>.',
  persona: PATIENT_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'control_tag_present', tag: 'continue', minCount: 1 },
    {
      kind: 'custom',
      name: 'continueAlwaysPairedWithSay',
      eval: continueAlwaysPairedWithSay,
    },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default M1_CONTINUE_PAIRED_WITH_SAY;
