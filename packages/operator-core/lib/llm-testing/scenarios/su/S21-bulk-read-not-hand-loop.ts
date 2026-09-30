/**
 * SU-S21 — reach for the bulk READ arg over a per-id hand-loop
 * (bulk-endpoint-standardization-2026-06-21 P-007; the READ counterpart of S16's
 * bulk WRITE).
 *
 * Question: when the engineer needs the SAME detail for every item in a
 * collection (here: the assignee + parent of each of 6 open work-items), does it
 * collapse the per-id read into ONE bulk `work_items:get { ids:[…] }` call —
 * every repeated-call read is now dual-arity (id|ids via _bulk), so n=1 is just
 * the single-element case of the bulk call — rather than firing
 * `work_items:get { id }` once per item?
 *
 * `work_items:list` returns 6 open items without the assignee/parent detail, so
 * the question forces a get over all 6; the only choice under test is bulk-vs-loop.
 *
 * Load-bearing assert (ERROR): `work_items:get` is called. Secondary (ERROR): at
 * most ONE `work_items:get` call total — the 6 reads belong in ONE
 * `{ ids:[…] }` call, not a per-id hand-loop.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalledWithArrayArg, assertToolCallCountAtMost } from './_asserts';
import { BULK_GET_CONTEXT } from './_overrides';

export const SU_S21_BULK_READ_NOT_HAND_LOOP: Scenario = {
  id: 'su-S21-bulk-read-not-hand-loop',
  version: 2,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer who owns each of the open work-items in the papercusp harness and what each one\'s parent is. work_items:list returns 6 open items but WITHOUT the assignee/parent detail, so the engineer must work_items:get over all 6. It should collapse those reads into ONE bulk work_items:get { ids:[…] } call (every repeated-call read is dual-arity, n=1 ≡ bulk-of-one) rather than issuing work_items:get { id } once per item.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 200, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: BULK_GET_CONTEXT,
  asserts: [
    assertToolCalledWithArrayArg(['work_items:get'], 'ids', 6, {
      name: 'reaches-for-bulk-get',
      claim:
        'Expected the engineer to fetch the 6 items\' detail via work_items:get { ids:[…] } — ' +
        'no call carried all 6 ids.',
      suggestion: 'Pass every id you need in ONE work_items:get { ids:[…] } call.',
    }),
    assertToolCallCountAtMost(['work_items:get'], 1, {
      name: 'does-not-hand-loop-reads',
      claim:
        'The engineer fired per-id work_items:get reads one at a time instead of one bulk ' +
        '{ ids:[…] } call — n=1 repeated is exactly what the dual-arity bulk arg replaces.',
      suggestion: 'Collapse the per-id reads into a single work_items:get { ids:[…] } call.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S21_BULK_READ_NOT_HAND_LOOP;
