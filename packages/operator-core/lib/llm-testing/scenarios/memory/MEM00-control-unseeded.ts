/**
 * MEM00 — control: identical task, NO seeded memory
 *
 * T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009, D-005).
 *
 * The falsifiability control for the whole tier (mirrors D-001's
 * NoopBackend control in the deterministic suite): run MEM02's exact
 * task with NOTHING seeded and assert the unknowable token does NOT
 * appear. If this scenario ever fails, the token is guessable and every
 * seeded scenario's positive result is suspect — the tier measures
 * nothing. While it passes, a MEM02 pass is attributable to boot-recall
 * alone.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';

export const MEM00_CONTROL_UNSEEDED: Scenario = {
  id: 'op-MEM00-control-unseeded',
  version: 1,
  target: 'operator',
  description:
    'A brief admin reports that the scratch-relay sidecar exits immediately after launch with exit code 0 and no error output, and asks what to check. (Control scenario: no team knowledge exists about this; the operator is expected to give its best generic debugging guidance.)',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  // Deliberately NO setup — this is the unseeded control.
  realWorkspace: true,
  caps: { maxTurns: 4, maxWallSecs: 300, maxCostUsd: 1.0 },
  asserts: [
    // The token seeded in MEM02 must NOT surface without the seed.
    { kind: 'text_excludes', pattern: /PAPERCUSP_RELAY_SALT/i },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default MEM00_CONTROL_UNSEEDED;
