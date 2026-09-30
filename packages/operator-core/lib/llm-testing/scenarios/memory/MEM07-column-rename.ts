/**
 * MEM07 — boot-recall: schema-rename debugging fact
 *
 * T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009, D-005).
 *
 * Question: a "what changed" debugging fact (fictional: a column rename
 * to persona_slug). The error message the user reports names only the
 * OLD column, so the new name can only come from the seeded memory.
 */

import { PEDANTIC_DEV } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';

export const MEM07_COLUMN_RENAME: Scenario = {
  id: 'op-MEM07-column-rename',
  version: 1,
  target: 'operator',
  description:
    'A developer reports that their dashboard query against harness_shared.spawned_agents started failing with a "column \\"role\\" does not exist" error and asks what happened. The team recorded the schema change behind exactly this breakage; success looks like the operator surfacing the recorded rename — including the NEW column name — from operator memory.',
  persona: PEDANTIC_DEV,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  setup: {
    mem0: [
      {
        kind: 'project',
        body: 'harness_shared.spawned_agents.role was renamed to persona_slug (migration 158). Anything still querying the old `role` column fails with SQLSTATE 42703 "column does not exist" — update queries to persona_slug.',
      },
    ],
  },
  realWorkspace: true,
  caps: { maxTurns: 4, maxWallSecs: 300, maxCostUsd: 1.0 },
  asserts: [
    { kind: 'text_contains', pattern: /persona_slug/i },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default MEM07_COLUMN_RENAME;
