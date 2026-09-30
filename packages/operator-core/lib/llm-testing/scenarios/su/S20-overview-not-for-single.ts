/**
 * SU-S20 — no harness:overview over-application on a single-fact question
 * (tool-call-batching-wrappers P-008 / D-008, the wrapper's "NOT WHEN" guard).
 *
 * Question: harness:overview bundles status + escalations + the open-issues snapshot.
 * For a SINGLE "is the sheets harness active right now?" — answerable by one
 * harness:status call — does the engineer call harness:status directly, or over-apply
 * harness:overview and pay for the escalation + issues folds it would also fetch?
 *
 * Load-bearing assert (ERROR): harness:status is called and harness:overview is NOT.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled, assertToolNotCalled } from './_asserts';
import { HARNESS_STATUS_RESULT } from './_overrides';

export const SU_S20_OVERVIEW_NOT_FOR_SINGLE: Scenario = {
  id: 'su-S20-overview-not-for-single',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer a single-fact question: "is the sheets harness active right now / what phase is it in?" — answerable by one harness:status call. The engineer should call harness:status directly and answer, NOT wrap it in harness:overview (which would also fetch escalations + the open-issues snapshot — over-applying the "state of X" bundle to a single status lookup).',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 120, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: HARNESS_STATUS_RESULT,
  asserts: [
    assertToolCalled(['harness:status'], {
      name: 'answers-single-fact-directly',
      claim: 'Expected a direct harness:status call to answer the single-fact "is sheets active" question.',
      suggestion: 'For a one-shot status lookup, call harness:status directly.',
    }),
    assertToolNotCalled(['harness:overview'], {
      name: 'no-overview-for-single-status',
      claim:
        'The engineer wrapped a single status lookup in harness:overview — over-applying the "state of X" ' +
        'bundle on the exact case it should be avoided, paying for the escalation + issues folds too.',
      suggestion:
        'harness:overview is the multi-part "state of X" read. A lone "is it active" check is just harness:status.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S20_OVERVIEW_NOT_FOR_SINGLE;
