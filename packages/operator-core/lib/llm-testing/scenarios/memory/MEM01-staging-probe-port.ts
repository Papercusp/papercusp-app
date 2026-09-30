/**
 * MEM01 — boot-recall: staging health-probe port
 *
 * T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009, D-005):
 * an agent session whose task REQUIRES a known gotcha — did the operator's
 * pre-turn memory injection surface it?
 *
 * Question: when the harness memory pool holds a recorded procedure with a
 * fact the model cannot otherwise know (the fictional probe port 31785),
 * does the operator's answer use it? The token is invented and appears
 * NOWHERE the sim-user or judge can see (description/persona/goal stay
 * token-free), so the ONLY path into the assistant's text is the seeded
 * memory → boot-recall injection. MEM00 is the unseeded control proving
 * the token is unguessable.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';

export const MEM01_STAGING_PROBE_PORT: Scenario = {
  id: 'op-MEM01-staging-probe-port',
  version: 1,
  target: 'operator',
  description:
    'A brief admin just restarted the papercup staging operator service and asks how to verify it came back healthy. The team has a recorded gotcha about the correct way to health-probe staging after a restart; success looks like the operator surfacing that specific recorded procedure (it is available in operator memory) rather than only generic advice.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  setup: {
    mem0: [
      {
        kind: 'project',
        body: 'After restarting the papercup staging operator, health-probe it on port 31785 (the staging governor proxy), NOT :3170 directly — direct :3170 probes return false negatives while the governor is still draining.',
      },
    ],
  },
  realWorkspace: true,
  caps: { maxTurns: 4, maxWallSecs: 300, maxCostUsd: 1.0 },
  asserts: [
    // The unknowable token: only the seeded memory can supply it.
    { kind: 'text_contains', pattern: /31785/ },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default MEM01_STAGING_PROBE_PORT;
