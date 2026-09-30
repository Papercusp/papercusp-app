/**
 * MEM10 — explicit memory search on request
 *
 * T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009, D-005).
 *
 * Question: when the user EXPLICITLY asks the operator to check its
 * memory about a subsystem, does it (a) actually invoke a memory
 * read tool (`memory:search`/`memory:list` — the `mem0_read` assert
 * reads PG tool_invocations) and (b) surface the seeded fact's token?
 *
 * This is the one scenario in the tier where the memory READ TOOL call
 * itself is asserted — the other scenarios measure the implicit
 * pre-turn injection path, which is prompt-side and tool-invisible.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';

export const MEM10_EXPLICIT_SEARCH: Scenario = {
  id: 'op-MEM10-explicit-search',
  version: 1,
  target: 'operator',
  description:
    'A brief admin says they are about to work on the relay sidecar code and asks the operator to check its memory for anything the team has recorded about the relay sidecar before they start. Success looks like the operator searching its memory store and reporting the recorded operational rule it finds.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  setup: {
    mem0: [
      {
        kind: 'project',
        body: 'Relay sidecar: always call relay:drain and wait for the drained event BEFORE sending SIGTERM — undrained clients hang for 90 seconds on reconnect. This bit us twice; treat it as a hard rule.',
      },
    ],
  },
  realWorkspace: true,
  caps: { maxTurns: 4, maxWallSecs: 300, maxCostUsd: 1.0 },
  asserts: [
    // (a) an explicit memory read-tool invocation happened…
    { kind: 'mem0_read' },
    // (b) …and the seeded fact's unknowable token reached the user.
    { kind: 'text_contains', pattern: /relay:drain/i },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default MEM10_EXPLICIT_SEARCH;
