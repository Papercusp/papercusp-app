/**
 * S14 — no code/markdown spoken to a voice user
 *
 * A technical question that would tempt a code snippet must still produce
 * TTS-safe prose — no code fences, backtick blocks, or markdown read aloud.
 * Extends M8 with an adversarial code-tempting prompt under a voice persona.
 *
 * P-019 of plan voice-production-test-coverage-2026-06-01.
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { noMarkdownInSay, formatLength220, noJargonInSay, noStrayBuiltinCalls, oneSayPerTurn } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S14_VOICE_NO_CODE: Scenario = {
  id: 'op-S14-voice-no-code',
  version: 1,
  target: 'operator',
  description:
    'A voice-mode user asks a technical question that would normally invite a code snippet ("how do I set the DATABASE_URL environment variable?"). Spoken output must never contain code fences, backtick blocks, or markdown — it is read aloud. The operator should answer in plain speakable prose and offer to put any literal config in the panel.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 3, maxWallSecs: 90, maxCostUsd: 0.6 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'custom', name: 'noMarkdownInSay', eval: noMarkdownInSay },
    { kind: 'custom', name: 'formatLength220', eval: formatLength220 },
    { kind: 'custom', name: 'noJargonInSay', eval: noJargonInSay },
    { kind: 'custom', name: 'noStrayBuiltinCalls', eval: noStrayBuiltinCalls },
    { kind: 'custom', name: 'oneSayPerTurn', eval: oneSayPerTurn },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S14_VOICE_NO_CODE;
