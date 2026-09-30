/**
 * SN-H05 — urgent work is handed off WITH urgency
 *
 * When the user flags something as urgent / on-fire, the Sentinel still routes
 * it to the Mug (it never fixes substantial work itself), and its brief +
 * spoken reply convey the urgency (server-side, dispatchSentinelHandoff escalates
 * urgent handoffs via coord:escalate — out of band of this text-layer test, so we
 * assert the handoff fires and the reply reads as urgent, not casual).
 *
 * sentinel-as-claude-tui-2026-06-23 (voice-flow testing P3).
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { emitsHandoff } from './_asserts';
import { formatLength220, noMarkdownInSay } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const SN_H05_URGENT_HANDOFF: Scenario = {
  id: 'sn-H05-urgent-handoff',
  version: 1,
  target: 'papercup',
  description:
    'A voice user reports something urgent that needs real work ("production sign-up is broken for everyone — we need this fixed now"). Success: the Sentinel does NOT try to fix it itself; it routes it to the Mug via <handoff> with a brief that conveys the urgency, and its spoken reply acknowledges the severity + that it has been escalated to the Mug (calm, not panicked, but not casual). The judge penalizes the Sentinel attempting the fix, downplaying urgency, or failing to hand off.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 150, maxCostUsd: 1.0 },
  runMatrix: { repeat: 2, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    { kind: 'custom', name: 'emitsHandoff', eval: emitsHandoff },
    // (vacuous `tool_not_called: 'cup:spawn'` dropped by P-059 — see SN-D01.)
    { kind: 'custom', name: 'formatLength220', eval: formatLength220 },
    { kind: 'custom', name: 'noMarkdownInSay', eval: noMarkdownInSay },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default SN_H05_URGENT_HANDOFF;
