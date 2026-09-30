/**
 * SU-S16 — a HOMOGENEOUS batch write collapses into ONE bulk verb call
 * (bulk-endpoint-standardization-2026-06-21 D-004; supersedes the original
 * code-execution-tool-orchestration B-CX-3 framing).
 *
 * Question: when the user asks to apply the SAME mutation to every item in a
 * collection (here: move every open work item to `wip`), does
 * the engineer reach for the verb's BULK arg — ONE `work_items:set_state { ids:[…],
 * state }` — instead of firing the write once per item?
 *
 * D-004 reconciliation: every repeated-call verb is now dual-arity (items[]/ids[]
 * via _bulk), so a HOMOGENEOUS batch is one bulk call. `code:run` (its dry-run /
 * confirm gate) is now reserved for HETEROGENEOUS / CONDITIONAL batches (different
 * per-item logic, computed values, branching) — not a flat same-state sweep.
 *
 * `work_items:list` returns 9 open items; the per-item state change is the loop.
 *
 * Load-bearing assert (ERROR): `work_items:set_state` is called. Secondary (ERROR):
 * at most two `work_items:set_state` calls total — the 9 writes belong in ONE bulk
 * `{ ids:[…], state }` call, not a per-item hand-loop.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalledWithArrayArg, assertToolCallCountAtMost } from './_asserts';
import { BATCH_WRITE_CONTEXT } from './_overrides';

export const SU_S16_CODE_RUN_BATCH_WRITE: Scenario = {
  id: 'su-S16-code-run-batch-write',
  version: 3,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to move every open work item in the papercusp harness to wip — the SAME valid lifecycle change applied to a collection. work_items:list returns 9 open items. The engineer should collapse the per-item write into ONE bulk work_items:set_state { ids:[…], state:"wip" } call (every repeated-call verb is now dual-arity) rather than issuing a write per item or reaching for code:run (which is for heterogeneous/conditional batches).',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 200, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: BATCH_WRITE_CONTEXT,
  asserts: [
    assertToolCalledWithArrayArg(['work_items:set_state'], 'ids', 9, {
      name: 'reaches-for-bulk-set-state',
      claim:
        'Expected the engineer to move all 9 open items via one bulk work_items:set_state ' +
        '{ ids:[…], state:"wip" } call — no call carried all 9 ids.',
      suggestion: 'Collapse the homogeneous mutation into ONE work_items:set_state { ids:[…], state:"wip" } call.',
    }),
    assertToolCallCountAtMost(['work_items:set_state'], 2, {
      name: 'does-not-hand-loop-writes',
      claim: 'The engineer fired per-item work_items:set_state writes one at a time instead of one bulk { ids:[…], state } call.',
      suggestion: 'Pass all ids in a single work_items:set_state { ids:[…], state } call, not one direct call per item.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S16_CODE_RUN_BATCH_WRITE;
