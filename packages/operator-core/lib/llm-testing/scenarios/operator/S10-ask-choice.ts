/**
 * S10 — ask-choice
 *
 * Persona: admin explicitly asking for concrete options to pick from.
 *
 * Goal: push the operator to emit a `chat:ask_choice` card (or a
 *       bespoke `ctx.askUser` card) rather than guessing a single
 *       answer or asking a follow-up in free text.
 *
 * Covers: B11 (chat:ask_choice card emission) — judge's cardUsage axis
 *         scores this qualitatively too.
 */

import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S10_ASK_CHOICE: Scenario = {
  id: 'op-S10-ask-choice',
  version: 2,
  target: 'operator',
  description:
    'The user explicitly asks for several concrete options to pick from. The operator must call chat:ask_choice instead of returning an enumerated prose list ending in a free-text pick-one question.',
  persona: {
    id: 'vague-prompter',
    description: 'User asks intentionally ambiguous prompts to push for card-based clarification.',
    traits: {
      verbosity: 'terse',
      politeness: 'neutral',
      clarification: 'never_clarifies',
      goalClarity: 'vague',
      interrupts: false,
      modality: 'text',
      domain: 'admin',
    },
  },
  goal: { kind: 'card_emitted', cardKind: 'choice' },
  // The live operator target allows up to 90s before its first SSE event;
  // keep the scenario wall above that transport budget so a cold turn is
  // judged on behavior instead of becoming a zero-turn false failure.
  caps: { maxTurns: 1, maxWallSecs: 120, maxCostUsd: 0.6 },
  runMatrix: { repeat: 5, variancePolicy: 'flag-if-disagreement' },
  triggers: [{
    on: 'after_turn',
    fire: 'user_message',
    param: 0,
    text: 'What should I focus on next? Give me a few concrete options to pick from.',
  }],
  asserts: [
    // Either a 'choice'-kind card or any voice-answerable card — both
    // satisfy the "use a card, don't free-text-ask" expectation.
    { kind: 'card_emitted', cardKind: 'choice' },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S10_ASK_CHOICE;
