/**
 * SN-D03 — follow-up on an existing deep delegation stays local
 * (voice-unified-sentinel-pipeline-2026-07-01, WI-1430).
 *
 * Question: when the user asks for the STATUS of analysis the Sentinel already
 * delegated ("how's that analysis going?"), does the Sentinel answer from the
 * open deep-delegation work-items it already has in context instead of creating
 * a new deep pass or handing the follow-up to the Queen?
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';
import { noDelegate, noHandoff } from './_asserts';
import { formatLength220, noMarkdownInSay } from '../../asserts/operator-format';

export const SN_D03_EXISTING_DELEGATION_STATUS: Scenario = {
  id: 'sn-D03-existing-delegation-status',
  version: 1,
  target: 'papercup',
  description:
    'A voice user asks the Sentinel for the status of analysis it already has in flight: "how\'s that migration-options analysis going?" Success: the Sentinel treats this as a STATUS follow-up and answers directly from the existing deep-delegation work-item context (or says it is still in flight / not back yet). The judge must NOT reward emitting <delegate_deep> again, handing it to the Mug, or pretending the work is done when it is still open.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 150, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    { kind: 'custom', name: 'noDelegate', eval: noDelegate },
    { kind: 'custom', name: 'noHandoff', eval: noHandoff },
    // (vacuous `tool_not_called: 'cup:spawn'` dropped by P-059 — see SN-D01.)
    { kind: 'custom', name: 'formatLength220', eval: formatLength220 },
    { kind: 'custom', name: 'noMarkdownInSay', eval: noMarkdownInSay },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default SN_D03_EXISTING_DELEGATION_STATUS;
