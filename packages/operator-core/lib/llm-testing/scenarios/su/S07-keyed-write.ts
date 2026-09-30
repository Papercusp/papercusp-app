/**
 * SU-S07 — keyed lifecycle-write contract.
 *
 * `work_items:set_state` used to be advertised as a positional `{row}` write,
 * but its live schema now has conditional terminal evidence and bulk fields.
 * This scenario keeps the behavioral probe aligned with the shipped contract:
 * a non-terminal state change is emitted as keyed JSON, never as a row.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolCallEvent } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolMatch } from './_asserts';
import { KEYED_WRITE_CONTEXT } from './_overrides';

/** Does this tool call set_state with keyed args for WI-42 → blocked? */
function emitsCorrectKeyedArgs(tc: ToolCallEvent): boolean {
  const canon = tc.name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
  if (canon !== 'work_items:set_state') return false;
  const input = (tc.input as Record<string, unknown> | null | undefined) ?? {};
  return input.id === 'WI-42' && input.state === 'blocked' && !('row' in input);
}

export const SU_S07_KEYED_WRITE: Scenario = {
  id: 'su-S07-keyed-write',
  version: 2,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to mark work item WI-42 as blocked — it is stuck waiting on an upstream fix. work_items:set_state uses keyed lifecycle args; terminal states additionally require completionRef and assumptions.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 3, maxWallSecs: 180, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  toolOverride: KEYED_WRITE_CONTEXT,
  asserts: [
    assertToolMatch(emitsCorrectKeyedArgs, {
      name: 'set-state-correct-keyed-args',
      claim: 'Expected `work_items:set_state` to be called with keyed args { id: "WI-42", state: "blocked" }, without a positional row.',
      suggestion:
        'Use keyed JSON for work_items:set_state. Positional rows are not advertised because terminal evidence cannot fit the row contract.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S07_KEYED_WRITE;
