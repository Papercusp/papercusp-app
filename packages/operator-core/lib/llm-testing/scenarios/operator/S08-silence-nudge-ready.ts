/**
 * S08 — silence-nudge → ready card
 *
 * Persona: brief admin who goes idle 30s mid-conversation.
 *
 * Runner injects a `silence_nudge` trigger after 30s of `awaiting_reply`.
 * Operator emits a 'ready' card with `voiceAnswerable: true`; sim-user
 * picks the option and the conversation resumes.
 *
 * Covers: B9 (silence-nudge card), B13 (voiceAnswerable card).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S08_SILENCE_NUDGE_READY: Scenario = {
  id: 'op-S08-silence-nudge-ready',
  version: 1,
  target: 'operator',
  description:
    'Admin asks a quick question, goes idle for 30s, then resumes by picking the "Ready" option on the silence-nudge card the operator emits.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 120, maxCostUsd: 1.0 },
  runMatrix: { repeat: 1, variancePolicy: 'none' },
  triggers: [{ on: 'silence', fire: 'silence_nudge', param: 30 }],
  asserts: [
    {
      kind: 'card_emitted',
      cardKind: 'ready',
      voiceAnswerable: true,
    },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S08_SILENCE_NUDGE_READY;
