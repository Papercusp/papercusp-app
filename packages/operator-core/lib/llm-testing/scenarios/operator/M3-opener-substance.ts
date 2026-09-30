/**
 * M3 — opener-substance (criticality:high)
 *
 * Plan: operator-behavior-tests-2026-05-14.md §3.1.
 * Brain-emission contract: opener never literally "what can I help
 * with"; must carry substance (count + slug + concrete invitation).
 * From operator.converse.md §3 rung 5: "Open with substance — never
 * with 'what can I help with'."
 *
 * Trigger setup: scripted open_canvas at turn 0 (bypasses sim-user).
 * SUT receives empty messages + trigger='open_canvas' — exactly the
 * production canvas-open path.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC_HIGH_CRITICALITY } from '../../rubrics/operator';
import { noBareWhatCanIHelp } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const M3_OPENER_SUBSTANCE: Scenario = {
  id: 'op-M3-opener-substance',
  version: 1,
  target: 'operator',
  description:
    'On open_canvas (sidebar opens with no active conversation), the operator must produce a substantive opener with at least one concrete fact (harness count, slug name, escalation count, or scan headline) and never the banned phrase "what can I help with".',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 1, maxWallSecs: 60, maxCostUsd: 1.0 },
  runMatrix: { repeat: 5, variancePolicy: 'flag-if-stddev>0.5' },
  triggers: [{ on: 'after_turn', fire: 'open_canvas', param: 0 }],
  realWorkspace: true,
  asserts: [
    { kind: 'custom', name: 'noBareWhatCanIHelp', eval: noBareWhatCanIHelp },
    {
      kind: 'text_contains',
      pattern: /\d+\s+(harness|escalation|scan|issue|feature)|sheets|operator|forms/i,
      turnIdx: 0,
    },
    { kind: 'tool_called', name: 'harness:list', minTimes: 1 },
  ],
  rubric: OPERATOR_RUBRIC_HIGH_CRITICALITY,
};

export default M3_OPENER_SUBSTANCE;
