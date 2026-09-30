/**
 * S01 — status-quick
 *
 * Persona: brief admin
 * Goal: get a quick status summary of the sheets harness.
 *
 * Covers: B1 (terminal reply), B14 (docs:* or harness:status tool),
 * B16 (harness tools), B17 (mem0 recall), B18 (mem0 write at turn end),
 * B28 (premature termination — judge-driven).
 *
 * Deterministic asserts:
 *   - harness:status (or harness-related tool) was called
 *   - latency p95 under 10s
 *   - cost under $0.50
 *
 * Judge axes: all (helpfulness, groundedness, terminationFit, ...).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S01_STATUS_QUICK: Scenario = {
  id: 'op-S01-status-quick',
  version: 1,
  target: 'operator',
  description:
    'A brief admin asks for a quick status summary of the sheets harness. The operator should call harness:status (or features:get / work_items:list as needed), summarize, and stop. No <continue/> chain expected.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 90, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    {
      kind: 'tool_called',
      name: 'harness:status',
      minTimes: 1,
    },
    { kind: 'latency_under', p95: 10000 },
    { kind: 'cost_under', usd: 0.5 },
    // "No <continue/> chain expected" (see description): 0 is correct, cap at 1
    // to catch a runaway chain. control_tag_present defaults minCount to 1, so
    // minCount:0 is required — otherwise a correct one-shot reply (0 continues)
    // wrongly fails.
    { kind: 'control_tag_present', tag: 'continue', minCount: 0, maxCount: 1 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S01_STATUS_QUICK;
