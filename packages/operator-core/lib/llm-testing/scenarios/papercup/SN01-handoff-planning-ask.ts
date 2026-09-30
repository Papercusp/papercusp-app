/**
 * SN01 — Sentinel hands a planning-scale ask off to the Mug
 *
 * Question: when a VOICE user asks the Sentinel for substantial, multi-step
 * work that needs planning + placement (NOT a quick status answer), does the
 * Sentinel ROUTE it to the Mug via `<handoff>` rather than trying to
 * plan/place/do it itself? The Sentinel talks, suggests, files + nudges; the
 * Mug acts (sentinel.persona.md — "you suggest and hand off; you never place
 * work yourself").
 *
 * Why we can assert on the tag: the agent-mcp/operator-converse route streams
 * the assistant turn RAW (the client strips control tags for display; the
 * server re-parses the assembled turn to dispatch the handoff — file a
 * high-priority user-requested work_item + nudge the Mug, converse.ts ~L504).
 * So `<handoff` appears in the harness's accumulated assistantText.
 * Honored ONLY for role==='sentinel', which is why this runs on the `sentinel`
 * target (the operator target can never trigger it).
 *
 * sentinel-as-claude-tui-2026-06-22 — voice round-trip coverage (the voice→
 * Sentinel→Mug handoff path; the full real-mic round-trip stays a manual
 * agent-e2e check, there being no mic/STT/EL in CI).
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { emitsHandoff } from './_asserts';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const SN01_HANDOFF_PLANNING_ASK: Scenario = {
  id: 'sn-S01-handoff-planning-ask',
  version: 1,
  target: 'papercup',
  description:
    'A voice user asks the Sentinel for substantial, multi-step work that needs the Mug to plan and place it (e.g. "I want to redesign the whole onboarding flow end to end — can you get that going for me?"). Success: the Sentinel does NOT plan, spawn, or execute the work itself; it routes the work to the Mug by emitting <handoff> (which the server files as a high-priority user-requested work-item and nudges the Mug), and its spoken reply tells the user it has been handed to the Mug. The judge must NOT reward the Sentinel attempting the work, proposing a detailed plan itself, or spawning a worker — only acknowledging + handing off. Quick offers ("want me to hand that to the Mug?") followed by the user agreeing and the Sentinel then handing off are ideal.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 150, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    { kind: 'custom', name: 'emitsHandoff', eval: emitsHandoff },
    // The Sentinel must NEVER place work itself. That contract is carried by
    // `emitsHandoff` above + the judge rubric, NOT by a tool assert: a
    // `tool_not_called: 'cup:spawn'` sat here until P-059 and could never fail
    // (the role was excluded from the verb's agentRoles, and the `<spawn>` tag
    // is `!isSentinel`-guarded), and the verb is now retired. See SN-D01.
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default SN01_HANDOFF_PLANNING_ASK;
