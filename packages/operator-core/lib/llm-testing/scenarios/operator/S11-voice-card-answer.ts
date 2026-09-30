/**
 * S11 — voice-card-answer
 *
 * Persona: voice-mode admin who can't see text-only UI affordances.
 *
 * The persona's `modality: 'voice'` flows through to the operator
 * converse-route via TurnInput.meta.modality. The operator brain
 * knows to emit voiceAnswerable cards (with fallbackText) rather
 * than plain text-only buttons.
 *
 * Covers: B13 (voiceAnswerable cards), B23 (modality plumbing).
 *
 * Asserts:
 *   - When a card is emitted, it must have voiceAnswerable=true
 *   - text answers stay terse (judge's `speakability` axis scores
 *     this qualitatively — see rubric §6.1)
 */

import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S11_VOICE_CARD_ANSWER: Scenario = {
  id: 'op-S11-voice-card-answer',
  version: 1,
  target: 'operator',
  description:
    'Voice-mode admin asks an ambiguous question that should prompt a choice card. The card MUST be voiceAnswerable (has fallbackText), and the operator\'s text must be terse enough to speak (≤2 sentences per turn).',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 60, maxCostUsd: 0.8 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    // If ANY card emitted, it must be voiceAnswerable.
    {
      kind: 'custom',
      name: 'cards-are-voice-answerable',
      eval: (run) => {
        const offenders: number[] = [];
        for (let i = 0; i < run.turns.length; i++) {
          for (const c of run.turns[i].cards) {
            if (!c.voiceAnswerable) offenders.push(i);
          }
        }
        if (offenders.length === 0) return [];
        return [{
          assertKind: 'custom:cards-are-voice-answerable',
          severity: 'error',
          evidenceTurnIdx: offenders[0],
          claim: `Card(s) emitted on turn(s) ${offenders.join(', ')} without voiceAnswerable=true — voice user can't answer them.`,
          suggestion: 'Set fallbackText on the card so it can be rendered + answered by voice.',
        }];
      },
    },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S11_VOICE_CARD_ANSWER;
