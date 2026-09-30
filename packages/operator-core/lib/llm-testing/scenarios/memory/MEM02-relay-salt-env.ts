/**
 * MEM02 — boot-recall: silent-exit env var
 *
 * T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009, D-005).
 *
 * Question: a debugging task whose ONLY good answer is a seeded gotcha —
 * a fictional sidecar exits silently unless a fictional env var is set.
 * The env-var name (PAPERCUSP_RELAY_SALT) is invented; if the assistant
 * names it, boot-recall surfaced the memory. MEM00 runs the identical
 * task UNSEEDED as the control.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';

export const MEM02_RELAY_SALT_ENV: Scenario = {
  id: 'op-MEM02-relay-salt-env',
  version: 1,
  target: 'operator',
  description:
    'A brief admin reports that the scratch-relay sidecar exits immediately after launch with exit code 0 and no error output, and asks what to check. The team has previously recorded the root cause of exactly this symptom; success looks like the operator surfacing that recorded cause (available in operator memory) as the first thing to check.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  setup: {
    mem0: [
      {
        kind: 'project',
        body: 'The scratch-relay sidecar exits silently (code 0, nothing logged) when PAPERCUSP_RELAY_SALT is unset. Always export PAPERCUSP_RELAY_SALT before launching it — this is the first thing to check on a silent exit.',
      },
    ],
  },
  realWorkspace: true,
  caps: { maxTurns: 4, maxWallSecs: 300, maxCostUsd: 1.0 },
  asserts: [
    { kind: 'text_contains', pattern: /PAPERCUSP_RELAY_SALT/i },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default MEM02_RELAY_SALT_ENV;
