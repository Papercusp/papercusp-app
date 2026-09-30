/**
 * SN-H03 — "who's the Mug, and what can she do?"
 *
 * A concept question (no live lookup required): the Sentinel should explain the
 * Mug's role — the planner/placer of work across the swarm — and that the
 * Sentinel itself routes substantial work TO her (the handoff), speakably and
 * accurately. Guards the Sentinel's self-model of the hive's division of labor.
 *
 * sentinel-as-claude-tui-2026-06-23 (voice-flow testing P2).
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { formatLength220, noMarkdownInSay } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const SN_H03_MUG_EXPLAINER: Scenario = {
  id: 'sn-H03-mug-explainer',
  version: 1,
  target: 'papercup',
  description:
    'A voice user asks the Sentinel "who is the Mug and what can she do?". Success: the Sentinel explains, speakably, that the Mug is the planner/placer who breaks down and assigns work across the swarm, and that the Sentinel itself hands substantial work to her (rather than doing it). The judge should reward an accurate, concise self-model of the hive division of labor and penalize confusion (e.g. claiming the Sentinel plans/places work itself, or inventing capabilities).',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 3, maxWallSecs: 120, maxCostUsd: 0.8 },
  runMatrix: { repeat: 1, variancePolicy: 'none' },
  asserts: [
    { kind: 'text_contains', pattern: /mug/i },
    { kind: 'custom', name: 'formatLength220', eval: formatLength220 },
    { kind: 'custom', name: 'noMarkdownInSay', eval: noMarkdownInSay },
    { kind: 'cost_under', usd: 0.8 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default SN_H03_MUG_EXPLAINER;
