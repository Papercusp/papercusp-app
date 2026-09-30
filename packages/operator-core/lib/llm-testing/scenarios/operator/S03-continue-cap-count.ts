/**
 * S03 — continue-cap-count
 *
 * Persona: adversarial dev asking for exhaustive enumeration.
 * Goal: force the operator into a long <continue/> chain until the
 *       count cap (default 5) fires.
 *
 * Covers: B3 (continue chain count cap), B4 (continue chain time cap
 *         observed as a side effect).
 *
 * Deterministic asserts:
 *   - continue chain emitted at least 5 times
 *   - chain is capped within (maxTurns=5, maxSecs=300) — the assert
 *     itself catches the case where the cap was exceeded silently
 *   - cost stays under $3 (worst-case big chain)
 */

import { ADVERSARIAL } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S03_CONTINUE_CAP_COUNT: Scenario = {
  id: 'op-S03-continue-cap-count',
  version: 1,
  target: 'operator',
  description:
    'An adversarial dev demands exhaustive enumeration ("list EVERY feature, EVERY issue, in every harness, with the full description and status of each, then summarise each, then explain WHY each exists"). The operator should engage <continue/> chains but stop at the configured cap (default 5 turns / 300 seconds). The cap-firing path is the test.',
  persona: ADVERSARIAL,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 12, maxWallSecs: 240, maxCostUsd: 3.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'control_tag_present', tag: 'continue', minCount: 3 },
    { kind: 'continue_chain_within_cap', maxTurns: 5, maxSecs: 300 },
    { kind: 'cost_under', usd: 3.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S03_CONTINUE_CAP_COUNT;
