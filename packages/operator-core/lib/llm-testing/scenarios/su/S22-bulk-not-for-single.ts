/**
 * SU-S22 — do NOT over-apply the bulk path on a single item
 * (bulk-endpoint-standardization-2026-06-21 P-007; the n=1 guard, counterpart of
 * S21's reach-for-bulk).
 *
 * Question: dual-arity means n=1 is the SCALAR form — `work_items:get { id }` —
 * not a degenerate one-element batch wrapped in `work_items:list` browsing or a
 * fan-out. When the user asks about exactly ONE work-item by id, does the
 * engineer answer with ONE direct `work_items:get { id }` call, instead of
 * over-applying the collection machinery (listing the queue to "find" an id it
 * was already handed)?
 *
 * The user names a single id (WI-600) and asks its state/owner — answerable by
 * one `work_items:get { id:'WI-600' }`. Reaching for `work_items:list` (a queue
 * browse) on a known single id is the over-application this guard catches.
 *
 * Load-bearing assert (ERROR): `work_items:get` is called and `work_items:list`
 * is NOT (no need to browse the queue for an id you were handed).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled, assertToolNotCalled, assertToolCallCountAtMost } from './_asserts';
import { BULK_GET_CONTEXT } from './_overrides';

export const SU_S22_BULK_NOT_FOR_SINGLE: Scenario = {
  id: 'su-S22-bulk-not-for-single',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    "A developer asks the engineer for the current state and owner of ONE work-item, WI-600 — a single-fact lookup by a known id. The engineer should answer with one direct work_items:get { id:'WI-600' } call (the n=1 scalar form of the dual-arity bulk read), NOT browse the queue with work_items:list to 'find' an id it was already handed, and not fan out repeated gets.",
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 120, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: BULK_GET_CONTEXT,
  asserts: [
    assertToolCalled(['work_items:get'], {
      name: 'answers-single-id-directly',
      claim: 'Expected a direct work_items:get { id } call to answer the single-id lookup.',
      suggestion: 'For a known single id, call work_items:get { id } — that IS the n=1 form of the bulk read.',
    }),
    assertToolNotCalled(['work_items:list'], {
      name: 'no-queue-browse-for-known-id',
      claim:
        'The engineer browsed the queue with work_items:list to locate an id it was already given — ' +
        'over-applying the collection machinery on a single known id.',
      suggestion: 'You were handed the id; fetch it directly with work_items:get { id }. work_items:list is for discovery, not a known id.',
    }),
    assertToolCallCountAtMost(['work_items:get'], 2, {
      name: 'no-redundant-get-fan-out',
      claim: 'The engineer issued multiple work_items:get calls for a single-id question.',
      suggestion: 'One work_items:get { id } answers a single-id lookup.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S22_BULK_NOT_FOR_SINGLE;
