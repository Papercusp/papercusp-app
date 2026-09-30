/**
 * SU-S19 — reach for harness:overview on a "state of X" question
 * (tool-call-batching-wrappers P-008 / P-006).
 *
 * Question: when the user wants the compound picture of one harness — its status,
 * its escalation record, AND the bounded cross-cutting open-issues snapshot —
 * does the engineer REACH for the ONE harness:overview bundle, or fan out
 * harness:status + harness:escalation + work_items:list one round-trip at a time?
 *
 * Load-bearing assert (ERROR): harness:overview is called. Secondary: the bundled
 * primitives are NOT hand-fanned.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled, assertToolCallCountAtMost } from './_asserts';
import { HARNESS_OVERVIEW_RESULT } from './_overrides';

export const SU_S19_OVERVIEW_STATE_OF_X: Scenario = {
  id: 'su-S19-overview-state-of-x',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer: give me the compound picture of the sheets harness — its current status, escalation record, and bounded cross-cutting open-issues snapshot. That is the "state of X" view harness:overview folds into one call. The supplied fixture contains the complete two-row issue snapshot (both rows fit under the bound) and the escalation fields needed for this request, so an accurate summary satisfies the ask without a detail-fetch follow-up. The engineer should call harness:overview { harness: "sheets" } once rather than fanning out harness:status + harness:escalation + work_items:list separately.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 150, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: HARNESS_OVERVIEW_RESULT,
  asserts: [
    assertToolCalled(['harness:overview'], {
      name: 'reaches-for-overview-on-state-of-x',
      claim:
        'Expected the engineer to answer the compound sheets-harness question with ONE ' +
        'harness:overview call (status + escalation + open-issues snapshot) — harness:overview was never called.',
      suggestion:
        'For "what\'s the state of harness X", call harness:overview { harness } — it folds status + escalations + the open-issues snapshot into one round-trip.',
    }),
    assertToolCallCountAtMost(['harness:status', 'harness:escalation', 'work_items:list'], 1, {
      name: 'does-not-hand-fan-the-overview-primitives',
      claim:
        'The engineer fanned out the overview primitives (harness:status / harness:escalation / work_items:list) ' +
        'separately instead of folding them into the single harness:overview call.',
      suggestion: 'harness:overview bundles those — prefer it for a "state of X" question.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S19_OVERVIEW_STATE_OF_X;
