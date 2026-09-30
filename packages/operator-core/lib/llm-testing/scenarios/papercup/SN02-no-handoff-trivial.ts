/**
 * SN02 — Sentinel does NOT hand off a quick, answerable question
 *
 * The guard against an over-eager Herald: a `<handoff>` files a
 * high-priority work_item and nudges the recipient, so handing off a trivial
 * status/recall question would spam the queue. When the user asks something the
 * Sentinel can answer directly (live status, a quick recall), it answers in
 * voice and does NOT emit `<handoff>`.
 *
 * Pairs with SN01 (the positive). Same `sentinel` target / raw-tag-in-stream
 * basis for the assertion (see SN01's header).
 *
 * sentinel-as-claude-tui-2026-06-22 — voice round-trip coverage.
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { noHandoff } from './_asserts';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const SN02_NO_HANDOFF_TRIVIAL: Scenario = {
  id: 'sn-S02-no-handoff-trivial',
  version: 1,
  target: 'papercup',
  description:
    'A voice user asks the Sentinel a quick, directly-answerable question (e.g. "what is the fleet up to right now?" / "how many agents are running?"). Success: the Sentinel answers in voice (consulting live status as needed) and does NOT emit <handoff> — a handoff files a high-priority work-item and nudges the Mug, so it must be reserved for substantial multi-step work, not trivia. The judge should reward a crisp spoken answer and penalize escalating a simple question to the Mug.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 120, maxCostUsd: 0.8 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    { kind: 'custom', name: 'noHandoff', eval: noHandoff },
    { kind: 'cost_under', usd: 0.8 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default SN02_NO_HANDOFF_TRIVIAL;
