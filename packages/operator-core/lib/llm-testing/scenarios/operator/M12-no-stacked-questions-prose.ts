/**
 * M12 — no-stacked-questions-prose
 *
 * Plan: operator-behavior-tests-2026-05-14.md §3.2.
 * Judge-leaning companion to M4 (deterministic count). M4 catches the
 * mechanical violation; M12 catches the disguised version where the
 * operator embeds multiple unrelated questions in flowing prose
 * ("...do you mean X — also, what about Y...").
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const M12_NO_STACKED_QUESTIONS_PROSE: Scenario = {
  id: 'op-M12-no-stacked-questions-prose',
  version: 1,
  target: 'operator',
  description:
    "A patient admin opens with several intertwined topics ('the marketplace pipeline, the typecheck baseline, and pricing — where are we?'). The operator should pick ONE thread and follow it, not stack unrelated questions back. terminationFit + tone judge axes catch the failure mode where the operator embeds multiple asks in flowing prose.",
  persona: PATIENT_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 180, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'latency_under', p95: 120000 },
    { kind: 'cost_under', usd: 2.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default M12_NO_STACKED_QUESTIONS_PROSE;
