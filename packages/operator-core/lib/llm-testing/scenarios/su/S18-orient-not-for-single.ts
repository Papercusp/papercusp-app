/**
 * SU-S18 — no coord:orient over-application on a single inbox check
 * (tool-call-batching-wrappers P-008 / D-008, the wrapper's "NOT WHEN" guard).
 *
 * Question: coord:orient bundles the whole wake-bootstrap (assignments + claimable +
 * inbox + plan-events + a memory recall + a declare). For a SINGLE "do I have any new
 * messages?" question — answerable by one coord:inbox call — does the engineer call
 * coord:inbox directly, or over-apply coord:orient and pay for the five other folds it
 * would also fetch (the result-payload cost the wrapper exists to AVOID on single reads)?
 *
 * Load-bearing assert (ERROR): coord:inbox is called and coord:orient is NOT.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled, assertToolNotCalled } from './_asserts';
import { COORD_INBOX_RESULT } from './_overrides';

export const SU_S18_ORIENT_NOT_FOR_SINGLE: Scenario = {
  id: 'su-S18-orient-not-for-single',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer a single question: "do I have any new messages / what\'s in my coordination inbox right now?" — answerable by one coord:inbox call. The engineer should call coord:inbox directly and answer, NOT wrap it in coord:orient (which would also fetch assignments + claimable + plan-events + a memory recall + declare an intent — over-applying the wake-bootstrap bundle to a single inbox read).',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 120, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: COORD_INBOX_RESULT,
  asserts: [
    assertToolCalled(['coord:inbox'], {
      name: 'answers-inbox-directly',
      claim: 'Expected a direct coord:inbox call to answer the single "new messages?" question.',
      suggestion: 'For a one-shot inbox read, call coord:inbox directly.',
    }),
    assertToolNotCalled(['coord:orient'], {
      name: 'no-orient-for-single-inbox-read',
      claim:
        'The engineer wrapped a single inbox read in coord:orient — over-applying the wake-bootstrap bundle ' +
        'on the exact case it should be avoided (one direct read), paying for five unneeded folds.',
      suggestion:
        'coord:orient is the WAKE bundle (assignments + claimable + inbox + plan-events + recall + declare). A lone inbox check is just coord:inbox.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S18_ORIENT_NOT_FOR_SINGLE;
