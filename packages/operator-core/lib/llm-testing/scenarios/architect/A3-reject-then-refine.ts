/**
 * A3 — reject-then-refine
 *
 * Persona: pedantic dev who rejects the first proposal ("that's not quite right")
 *          and gives feedback.
 *
 * Architect should accept the correction, refine the proposal, and NOT
 * silently accept the rejection as final. A refined second proposal must
 * appear — not a capitulation or a re-ask of clarifying questions already answered.
 */

import { PEDANTIC_DEV } from '@papercusp/testing-shell/llm';
import { ARCHITECT_RUBRIC } from '../../rubrics/architect';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const A3_REJECT_THEN_REFINE: Scenario = {
  id: 'architect-A3-reject-then-refine',
  version: 1,
  target: 'architect',
  description:
    'User rejects architect\'s first proposal ("too broad, cut the auth changes"). Architect must produce a concrete refined second proposal — not give up or repeat clarifying questions already answered.',
  persona: PEDANTIC_DEV,
  goal: { kind: 'state_reached', predicate: 'architect produced a refined second proposal after rejection' },
  caps: { maxTurns: 5, maxWallSecs: 120, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  realWorkspace: true,
  asserts: [
    {
      kind: 'custom',
      name: 'refined-proposal-after-rejection',
      eval: (run) => {
        // After turn 1 (the rejection turn), architect must produce text
        // showing a revised / narrower proposal.
        const afterRejection = run.turns.slice(1).map((t) => t.assistantText).join(' ').toLowerCase();
        const hasRefinement = /(narrow(ed)?|revised|cut|remov|instead|focus(ing)? on|limit(ed)? to|scoped to|without)/i.test(afterRejection);
        if (!hasRefinement) {
          return [{
            assertKind: 'custom:refined-proposal-after-rejection',
            severity: 'warn',
            claim: 'Architect did not produce a visibly narrower second proposal after user rejection.',
            suggestion: 'On rejection, architect should narrow scope or cut specific elements rather than restating the original proposal.',
          }];
        }
        return [];
      },
    },
  ],
  rubric: ARCHITECT_RUBRIC,
};

export default A3_REJECT_THEN_REFINE;
