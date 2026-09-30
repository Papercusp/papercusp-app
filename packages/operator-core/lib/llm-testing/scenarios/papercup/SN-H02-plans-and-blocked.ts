/**
 * SN-H02 — "what plans are in progress, and what's blocked?"
 *
 * A two-part live-state question. The Sentinel must consult a tool
 * (plans / work-items read) and summarize real in-progress plans + blocked
 * items, speakably — not invent them. realWorkspace for live plan/work-item data.
 *
 * sentinel-as-claude-tui-2026-06-23 (voice-flow testing P2).
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { consultedATool } from './_asserts';
import { formatLength220, noMarkdownInSay, oneQuestionMarkPerTurn } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const SN_H02_PLANS_AND_BLOCKED: Scenario = {
  id: 'sn-H02-plans-and-blocked',
  version: 1,
  target: 'papercup',
  description:
    'A voice user asks the Sentinel "what plans are in progress, and is anything blocked?". Success: the Sentinel calls a plans/work-items read tool and gives a grounded, speakable summary of real in-progress plans and any blocked / needs-human items — not invented ones. Penalize a blind answer (no tool call) or fabricated plan names; reward an accurate, concise, voice-friendly summary that flags blockers.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 150, maxCostUsd: 1.0 },
  realWorkspace: true,
  runMatrix: { repeat: 1, variancePolicy: 'none' },
  asserts: [
    { kind: 'custom', name: 'consultedATool', eval: consultedATool },
    { kind: 'custom', name: 'formatLength220', eval: formatLength220 },
    { kind: 'custom', name: 'noMarkdownInSay', eval: noMarkdownInSay },
    { kind: 'custom', name: 'oneQuestionMarkPerTurn', eval: oneQuestionMarkPerTurn },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default SN_H02_PLANS_AND_BLOCKED;
