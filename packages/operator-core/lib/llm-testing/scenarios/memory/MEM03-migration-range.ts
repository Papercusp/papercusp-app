/**
 * MEM03 — boot-recall: reserved migration-number range
 *
 * T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009, D-005).
 *
 * Question: a convention/coordination fact that exists only as a team
 * agreement (fictional: migrations 440-449 reserved; allocate from 450).
 * No tool can answer it; the model can't guess it. If the assistant tells
 * the user to allocate from 450, boot-recall surfaced the memory.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';

export const MEM03_MIGRATION_RANGE: Scenario = {
  id: 'op-MEM03-migration-range',
  version: 1,
  target: 'operator',
  description:
    'A brief admin is about to add a new SQL migration and asks whether there is any team agreement about which migration numbers are safe to allocate right now. There is a recorded reservation agreement; success looks like the operator surfacing the specific reserved range and the number to allocate from (available in operator memory), not generic "use the next number" advice.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  setup: {
    mem0: [
      {
        kind: 'project',
        body: 'Coordination agreement (2026-06-04): SQL migration numbers 440-449 are reserved for the federation track. New migrations from other lanes must allocate 450 or higher until the reservation is released.',
      },
    ],
  },
  realWorkspace: true,
  caps: { maxTurns: 4, maxWallSecs: 300, maxCostUsd: 1.0 },
  asserts: [
    // 450 (the allocate-from number) or the reserved range itself.
    { kind: 'text_contains', pattern: /\b(440\s*[-–]\s*449|450)\b/ },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default MEM03_MIGRATION_RANGE;
