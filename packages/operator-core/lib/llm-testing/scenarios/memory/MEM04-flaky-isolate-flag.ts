/**
 * MEM04 — boot-recall: flaky-test isolation flag
 *
 * T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009, D-005).
 *
 * Question: a known-flake workaround recorded as team feedback — a
 * fictional runner flag (--isolate-relay) fixes a fictional deadlocking
 * integration test. If the assistant names the flag, boot-recall
 * surfaced the memory.
 */

import { PEDANTIC_DEV } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';

export const MEM04_FLAKY_ISOLATE_FLAG: Scenario = {
  id: 'op-MEM04-flaky-isolate-flag',
  version: 1,
  target: 'operator',
  description:
    'A developer reports that relay-handshake.integration.test.ts keeps deadlocking in CI but passes when run alone locally, and asks whether this is a known issue with a known fix. The team has recorded exactly this flake and its workaround; success looks like the operator surfacing the recorded workaround (available in operator memory).',
  persona: PEDANTIC_DEV,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  setup: {
    mem0: [
      {
        kind: 'feedback',
        body: 'relay-handshake.integration.test.ts deadlocks when run in the same vitest invocation as other suites; run it with the --isolate-relay runner flag (added 2026-05-30) so it forks alone. Known flake — do not chase it as a real bug.',
      },
    ],
  },
  realWorkspace: true,
  caps: { maxTurns: 4, maxWallSecs: 300, maxCostUsd: 1.0 },
  asserts: [
    { kind: 'text_contains', pattern: /isolate-relay/i },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default MEM04_FLAKY_ISOLATE_FLAG;
