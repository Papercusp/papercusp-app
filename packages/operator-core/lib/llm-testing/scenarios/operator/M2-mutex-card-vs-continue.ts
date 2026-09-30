/**
 * M2 — mutex-card-vs-continue (guard-rail scenario)
 *
 * Plan: operator-behavior-tests-2026-05-14.md §3.1, §8.
 * Brain-emission contract: <continue/> and chat:ask_choice never in
 * the same turn. From operator.converse.md §5: "After calling
 * chat:ask_choice, END YOUR TURN. The buttons ARE the prompt."
 *
 * This is a guard-rail check — passes trivially when the brain
 * behaves; alarms only on regression. Inexpensive to run.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { noContinueWithAskChoice } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const M2_MUTEX_CARD_VS_CONTINUE: Scenario = {
  id: 'op-M2-mutex-card-vs-continue',
  version: 1,
  target: 'operator',
  description:
    'An ambiguous request: "I want to look at sheets, but maybe also fix the typecheck thing — what next?" The brain may pick either a card (chat:ask_choice) or a continued narration. Whichever it picks, it must NOT do both in the same turn.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 180, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    {
      kind: 'custom',
      name: 'noContinueWithAskChoice',
      eval: noContinueWithAskChoice,
    },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default M2_MUTEX_CARD_VS_CONTINUE;
