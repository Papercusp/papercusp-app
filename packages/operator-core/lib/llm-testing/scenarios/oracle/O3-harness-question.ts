/**
 * O3 — harness-question
 *
 * Persona: patient admin asking a harness-scoped question.
 *
 * Tests oracle's ability to reach for harness:* tools when the
 * question is about workspace state rather than docs.
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import { ORACLE_RUBRIC } from '../../rubrics/oracle';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const O3_HARNESS_QUESTION: Scenario = {
  id: 'oracle-O3-harness-question',
  version: 1,
  target: 'oracle',
  description:
    'A patient admin asks a question about a specific harness ("what features are in the sheets harness?"). Oracle should call harness:* tools, not docs:*, since the answer is workspace state, not documentation.',
  persona: PATIENT_ADMIN,
  goal: { kind: 'tool_fired', toolName: 'harness:status' },
  caps: { maxTurns: 4, maxWallSecs: 90, maxCostUsd: 0.8 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  realWorkspace: true,
  asserts: [
    { kind: 'tool_called', name: 'harness:status', minTimes: 1 },
    // Should NOT spam docs:search for a state question.
    { kind: 'tool_called', name: 'docs:search', maxTimes: 1 },
  ],
  rubric: ORACLE_RUBRIC,
};

export default O3_HARNESS_QUESTION;
