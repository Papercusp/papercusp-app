/**
 * SN-H06 — respect an explicit "don't escalate, just answer me"
 *
 * The user asks a directly-answerable question AND explicitly says not to bother
 * the Mug with it ("don't hand this to the Mug, just tell me what's running").
 * The Sentinel must honor that: answer directly (consulting a tool for live
 * state) and NOT emit <handoff>. Guards against an over-eager Herald
 * that escalates even when told not to.
 *
 * sentinel-as-claude-tui-2026-06-23 (voice-flow testing P3).
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { noHandoff, consultedATool } from './_asserts';
import { formatLength220, noMarkdownInSay } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const SN_H06_RESPECT_NO_HANDOFF: Scenario = {
  id: 'sn-H06-respect-no-handoff',
  version: 1,
  target: 'papercup',
  description:
    'A voice user asks a directly-answerable live-state question and explicitly says NOT to involve the Mug ("just tell me what agents are running — don\'t bother the Mug with it"). Success: the Sentinel answers directly (calling a read tool for live state) and does NOT emit <handoff> — it respects the user\'s explicit instruction not to escalate. The judge penalizes any handoff here and rewards a crisp, tool-grounded direct answer.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 150, maxCostUsd: 1.0 },
  realWorkspace: true,
  runMatrix: { repeat: 2, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    { kind: 'custom', name: 'noHandoff', eval: noHandoff },
    { kind: 'custom', name: 'consultedATool', eval: consultedATool },
    { kind: 'custom', name: 'formatLength220', eval: formatLength220 },
    { kind: 'custom', name: 'noMarkdownInSay', eval: noMarkdownInSay },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default SN_H06_RESPECT_NO_HANDOFF;
