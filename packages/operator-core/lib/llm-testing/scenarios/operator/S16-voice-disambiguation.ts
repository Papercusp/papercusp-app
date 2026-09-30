/**
 * S16 — voice disambiguation via a voiceAnswerable card
 *
 * Given an ambiguous instruction across several candidates, the operator should
 * surface a single voiceAnswerable choice card (with fallbackText) rather than
 * read a long list aloud — and keep its spoken turns terse. Complements S11
 * (which proves cards are voiceAnswerable) with a concrete pick-one-of-many
 * disambiguation flow.
 *
 * P-019 of plan voice-production-test-coverage-2026-06-01.
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { formatLength220, noJargonInSay, noStrayBuiltinCalls, disambiguationCardRequired, oneSayPerTurn } from '../../asserts/operator-format';
import type { Scenario, RunSummary, Violation } from '@papercusp/testing-shell/llm';

const cardsAreVoiceAnswerable = (run: RunSummary): Violation[] => {
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
    claim: `Card(s) on turn(s) ${offenders.join(', ')} lack voiceAnswerable=true — a voice user can't answer them.`,
    suggestion: 'Set fallbackText on the card so the voice surface can announce + accept the answer.',
  }];
};

export const S16_VOICE_DISAMBIGUATION: Scenario = {
  id: 'op-S16-voice-disambiguation',
  version: 1,
  target: 'operator',
  description:
    'A voice-mode user gives an ambiguous instruction spanning multiple candidates ("approve the busy one"). Rather than reading a long list aloud, the operator should surface a single voiceAnswerable choice card (with fallbackText) to disambiguate, and keep its spoken turns terse (≤220 chars).',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 90, maxCostUsd: 0.8 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'custom', name: 'cards-are-voice-answerable', eval: cardsAreVoiceAnswerable },
    { kind: 'custom', name: 'formatLength220', eval: formatLength220 },
    { kind: 'custom', name: 'noJargonInSay', eval: noJargonInSay },
    // P-003: the scenario premise IS an ambiguous ≥2-candidate instruction —
    // a chat_ask_choice card is REQUIRED behavior, deterministically.
    { kind: 'custom', name: 'disambiguationCardRequired', eval: disambiguationCardRequired },
    { kind: 'custom', name: 'noStrayBuiltinCalls', eval: noStrayBuiltinCalls },
    { kind: 'custom', name: 'oneSayPerTurn', eval: oneSayPerTurn },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S16_VOICE_DISAMBIGUATION;
