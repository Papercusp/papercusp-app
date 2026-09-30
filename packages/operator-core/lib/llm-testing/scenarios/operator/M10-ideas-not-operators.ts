/**
 * M10 — ideas-not-operator's (criticality:high)
 *
 * Plan: operator-behavior-tests-2026-05-14.md §3.2.
 * Judge-leaning. Synthesis §10: "Do not put your ideas in front of
 * them as questions ('Have you thought about adding X?'). Ask about
 * what they're noticing, what isn't working, what would feel done.
 * The ideas are theirs to bring."
 *
 * Scored on the new `ideasOwnership` axis (rubric 1.1.0).
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC_HIGH_CRITICALITY } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const M10_IDEAS_NOT_OPERATORS: Scenario = {
  id: 'op-M10-ideas-not-operators',
  version: 1,
  target: 'operator',
  description:
    "The user is vague about a feeling ('I feel like the dashboard isn't quite right'). The operator should ask what they're noticing — get a concrete example out of them — NOT propose its own ideas ('have you considered X?', 'what if you tried Y?'). The ideas are theirs to bring.",
  persona: {
    ...PATIENT_ADMIN,
    traits: { ...PATIENT_ADMIN.traits, goalClarity: 'vague' },
  },
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 180, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  // Judge-only scenario — the contract lives entirely on the new
  // `ideasOwnership` axis plus helpfulness/tone. Loose latency+cost
  // sentinels keep the framework invariant happy.
  asserts: [
    { kind: 'latency_under', p95: 120000 },
    { kind: 'cost_under', usd: 3.0 },
  ],
  rubric: OPERATOR_RUBRIC_HIGH_CRITICALITY,
};

export default M10_IDEAS_NOT_OPERATORS;
