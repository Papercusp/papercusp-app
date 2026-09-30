/**
 * SN-H07 — a multi-item ask is handed off without dropping items
 *
 * The user rattles off several distinct pieces of substantial work in one breath.
 * The Sentinel must route them to the Mug via <handoff> with a brief
 * that captures ALL of them (not just the first / last), and confirm in voice
 * without trying to do any itself. Tests brief fidelity under a multi-part ask.
 *
 * sentinel-as-claude-tui-2026-06-23 (voice-flow testing P3).
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { emitsHandoff } from './_asserts';
import { formatLength220, noMarkdownInSay, oneQuestionMarkPerTurn } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const SN_H07_MULTI_ITEM_HANDOFF: Scenario = {
  id: 'sn-H07-multi-item-handoff',
  version: 1,
  target: 'papercup',
  description:
    'A voice user lists several distinct pieces of substantial work in one turn ("get the onboarding redesign going, also fix the billing export, and start a plan for the mobile app"). Success: the Sentinel routes the work to the Mug via <handoff> with a brief that captures ALL the listed items (none dropped), and confirms in voice without attempting any item itself or spawning a worker. The judge rewards full item coverage in the handoff/acknowledgement and penalizes dropped items or the Sentinel doing the work.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 150, maxCostUsd: 1.0 },
  runMatrix: { repeat: 2, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    { kind: 'custom', name: 'emitsHandoff', eval: emitsHandoff },
    // (vacuous `tool_not_called: 'cup:spawn'` dropped by P-059 — see SN-D01.)
    { kind: 'custom', name: 'formatLength220', eval: formatLength220 },
    { kind: 'custom', name: 'noMarkdownInSay', eval: noMarkdownInSay },
    { kind: 'custom', name: 'oneQuestionMarkPerTurn', eval: oneQuestionMarkPerTurn },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default SN_H07_MULTI_ITEM_HANDOFF;
