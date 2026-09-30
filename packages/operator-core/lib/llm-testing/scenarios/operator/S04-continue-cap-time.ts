/**
 * S04 — continue-cap-time
 *
 * Persona: adversarial dev demanding a wide enumeration.
 *
 * The time cap is enforced provider-side (V8 `maxContinueChainSecs`,
 * default 300s). The framework's runner doesn't drive the provider —
 * it POSTs to the converse route directly — so this scenario doesn't
 * fail-by-cap-fire the way S03 does. Instead it checks the *ledger*:
 * the chain row for the final turn must record `elapsed_secs_in_chain`
 * under the asserted cap.
 *
 * In practice with Sonnet + a realistic tool set, a 5-turn chain runs
 * 20–60s wallclock. We assert maxSecs=120 — well under prod's 300s
 * cap, comfortably above expected duration. A regression that
 * accidentally slows the operator (longer tool calls, retries, etc.)
 * trips the assert.
 *
 * Covers: B4 (time cap as observed via ledger), B3 (chain emission).
 */

import { ADVERSARIAL } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S04_CONTINUE_CAP_TIME: Scenario = {
  id: 'op-S04-continue-cap-time',
  version: 1,
  target: 'operator',
  description:
    'Adversarial dev forces a long <continue/> chain via a wide enumeration. The chain must complete inside the configured time cap. Asserts the ledger row records elapsed_secs_in_chain below the scenario cap (regression guard against operator slowdowns).',
  persona: ADVERSARIAL,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 10, maxWallSecs: 180, maxCostUsd: 2.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'control_tag_present', tag: 'continue', minCount: 2 },
    // Two-layer time cap: the assert checks ledger; the runner's
    // maxWallSecs is the hard timeout.
    { kind: 'continue_chain_within_cap', maxTurns: 6, maxSecs: 120 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S04_CONTINUE_CAP_TIME;
