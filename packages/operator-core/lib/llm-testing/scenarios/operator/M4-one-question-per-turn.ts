/**
 * M4 — one-question-per-turn
 *
 * Plan: operator-behavior-tests-2026-05-14.md §3.1.
 * Brain-emission contract: each <say> ends with ≤1 question. From
 * operator.converse.md §10 "Do not stack multiple questions in one
 * turn."
 *
 * Adversarial: helper ignores `?` inside JSON tool-arg literals,
 * inside backtick code blocks, and URL-encoded %3F.
 */

import { PEDANTIC_DEV } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { oneQuestionMarkPerTurn } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const M4_ONE_QUESTION_PER_TURN: Scenario = {
  id: 'op-M4-one-question-per-turn',
  version: 1,
  target: 'operator',
  description:
    'A pedantic developer presses for clarity on several unrelated topics ("status of sheets, also the marketplace, and what about the operator?"). The operator must answer one thing at a time — each turn ends with at most one ? — not stack questions back.',
  persona: PEDANTIC_DEV,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 180, maxCostUsd: 1.0 },
  runMatrix: { repeat: 1, variancePolicy: 'none' },
  asserts: [
    { kind: 'custom', name: 'oneQuestionMarkPerTurn', eval: oneQuestionMarkPerTurn },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default M4_ONE_QUESTION_PER_TURN;
