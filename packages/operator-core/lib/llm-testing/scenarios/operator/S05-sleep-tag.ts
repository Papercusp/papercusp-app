/**
 * S05 — sleep-tag
 *
 * Persona: patient admin asking for low-priority background work
 *          ("if you have a moment, scan the codebase for stale TODOs;
 *          not urgent — get back to me later").
 *
 * Covers: B6 (<sleep/> honored mid-chain — operator stays quiet for
 *         the requested duration rather than auto-firing follow-ups).
 *
 * Deterministic asserts:
 *   - <sleep/> tag present at least once
 *   - auto-fire did NOT happen (the sleep tag should suppress V8 terminal-auto-fire)
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S05_SLEEP_TAG: Scenario = {
  id: 'op-S05-sleep-tag',
  version: 1,
  target: 'operator',
  description:
    'Admin makes a low-priority background request and explicitly says no rush. The operator should acknowledge, do the immediate response, then emit a <sleep/> tag to indicate it is intentionally not auto-firing follow-ups.',
  persona: PATIENT_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 120, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'control_tag_present', tag: 'sleep', minCount: 1 },
    { kind: 'auto_fire_did_not_happen' },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S05_SLEEP_TAG;
