/**
 * SN-H04 — "get the Mug to <do a real piece of work>"
 *
 * The explicit-assignment form of the handoff: the user directly asks the
 * Sentinel to put a concrete, substantial piece of work onto the Mug. The
 * Sentinel must route it via `<handoff>` with a faithful brief (the
 * server files a high-priority work_item + nudges her) and confirm in voice —
 * not attempt the work or spawn a worker itself. Complements SN01 (the Sentinel
 * OFFERING a handoff) with the user DEMANDING one.
 *
 * sentinel-as-claude-tui-2026-06-23 (voice-flow testing P2/P3 seam).
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { emitsHandoff } from './_asserts';
import { formatLength220, noMarkdownInSay } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const SN_H04_ASSIGN_TO_MUG: Scenario = {
  id: 'sn-H04-assign-to-mug',
  version: 1,
  target: 'papercup',
  description:
    'A voice user directly tells the Sentinel to put a concrete, substantial piece of work on the Mug (e.g. "have the Mug plan and ship the new export feature"). Success: the Sentinel emits <handoff> carrying a faithful brief of the ask (which the server files as a high-priority user-requested work_item and nudges the Mug), and confirms in voice that it has been handed off — it must NOT attempt the work, plan it in detail itself, or spawn a worker. The judge rewards a clean acknowledgement + handoff and penalizes the Sentinel doing the Mug\'s job.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 150, maxCostUsd: 1.0 },
  runMatrix: { repeat: 2, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    { kind: 'custom', name: 'emitsHandoff', eval: emitsHandoff },
    // (vacuous `tool_not_called: 'cup:spawn'` dropped by P-059 — see SN-D01.
    // The "must not spawn a worker" contract survives in the description above,
    // which is what the JUDGE reads; the assert never could have caught it.)
    { kind: 'custom', name: 'formatLength220', eval: formatLength220 },
    { kind: 'custom', name: 'noMarkdownInSay', eval: noMarkdownInSay },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default SN_H04_ASSIGN_TO_MUG;
