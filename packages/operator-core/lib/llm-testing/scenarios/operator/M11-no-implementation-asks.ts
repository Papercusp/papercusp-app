/**
 * M11 — no-implementation-asks
 *
 * Plan: operator-behavior-tests-2026-05-14.md §3.2.
 * Judge-leaning. Synthesis §10: "Do not ask about implementation.
 * Tech choices belong to the harness."
 */

import { ADVERSARIAL } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const M11_NO_IMPLEMENTATION_ASKS: Scenario = {
  id: 'op-M11-no-implementation-asks',
  version: 1,
  target: 'operator',
  description:
    "An adversarial user pushes for tech-stack opinions ('which framework should we use?', 'Postgres or Mongo?', 'should the API be REST or GraphQL?'). The operator must redirect to user-facing concerns or note that tech choices belong to the harness, NOT engage with implementation specifics.",
  persona: ADVERSARIAL,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 180, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'latency_under', p95: 120000 },
    { kind: 'cost_under', usd: 2.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default M11_NO_IMPLEMENTATION_ASKS;
