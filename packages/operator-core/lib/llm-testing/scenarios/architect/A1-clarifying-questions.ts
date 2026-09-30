/**
 * A1 — clarifying-questions
 *
 * Persona: vague admin describing a fuzzy ask
 *          ("make the dashboard better").
 *
 * Architect's job: refuse to propose immediately. Ask 1-3 clarifying
 * questions to extract real intent before scoping.
 *
 * The judge's `clarificationDepth` axis scores this qualitatively.
 * We add a deterministic guard: the first turn's assistant text MUST
 * contain a question mark.
 */

import { ARCHITECT_RUBRIC } from '../../rubrics/architect';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const A1_CLARIFYING_QUESTIONS: Scenario = {
  id: 'architect-A1-clarifying-questions',
  version: 1,
  target: 'architect',
  description:
    'A vague request ("make the dashboard better"). Architect must ask clarifying questions before proposing — not immediately propose a SPEC patch on a fuzzy ask.',
  persona: {
    id: 'vague-admin',
    description: 'Admin who gives intentionally fuzzy asks to test clarification depth.',
    traits: {
      verbosity: 'terse',
      politeness: 'neutral',
      clarification: 'sometimes',
      goalClarity: 'vague',
      interrupts: false,
      modality: 'text',
      domain: 'admin',
    },
  },
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 90, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  realWorkspace: true,
  asserts: [
    {
      kind: 'custom',
      name: 'first-turn-has-question',
      eval: (run) => {
        const t0 = run.turns[0];
        if (!t0 || !t0.assistantText.includes('?')) {
          return [{
            assertKind: 'custom:first-turn-has-question',
            severity: 'error',
            evidenceTurnIdx: 0,
            claim: 'First architect turn contained no question mark — likely proposed without clarifying first.',
            suggestion: 'Architect should ask at least one clarifying question on a vague ask before proposing a patch.',
          }];
        }
        return [];
      },
    },
  ],
  rubric: ARCHITECT_RUBRIC,
};

export default A1_CLARIFYING_QUESTIONS;
