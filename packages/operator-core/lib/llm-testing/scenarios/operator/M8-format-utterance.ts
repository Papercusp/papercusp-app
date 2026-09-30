/**
 * M8 — format-utterance
 *
 * Plan: operator-behavior-tests-2026-05-14.md §3.1.
 * Brain-emission contract: each <say> ≤220 chars, no markdown,
 * TTS-safe. From operator.converse.md §"Format for every turn".
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { formatLength220, noMarkdownInSay } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const M8_FORMAT_UTTERANCE: Scenario = {
  id: 'op-M8-format-utterance',
  version: 1,
  target: 'operator',
  description:
    'A casual multi-turn discussion. The operator must keep each <say> block ≤220 chars (1-2 sentences) and never use markdown — no **bold**, no headings, no lists, no code fences. The output is TTS-safe.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 120, maxCostUsd: 0.8 },
  runMatrix: { repeat: 1, variancePolicy: 'none' },
  asserts: [
    { kind: 'custom', name: 'formatLength220', eval: formatLength220 },
    { kind: 'custom', name: 'noMarkdownInSay', eval: noMarkdownInSay },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default M8_FORMAT_UTTERANCE;
