/**
 * SU-S13 — code:run batch adoption (code-execution-tool-orchestration B-CX-3).
 *
 * Question: when a task is the canonical "do X for each of N" shape — list a
 * collection, then inspect and FILTER a bulky detail response — does the engineer
 * REACH for `code:run` (one returned summary, no full intermediate payload in
 * model context) instead of serially hand-looping the per-item tool?
 *
 * The user asks for the BLOCKED open work items + why. `work_items:list` returns
 * 12 items WITHOUT per-item state (override), so answering requires a
 * one bulk `work_items:get { ids:[…] }`. The native bulk call avoids RPC fan-out,
 * but would still return all detail rows into model context; the requested shape
 * is ONE `code:run` whose script performs the bulk read and returns only blocked
 * ids/reasons. The lazy path hand-loops `work_items:get` and hits the turn cap.
 *
 * Load-bearing assert (ERROR): `code:run` is called. Secondary (ERROR): the
 * engineer does NOT hand-loop `work_items:get` more than a couple times directly
 * (it batched the loop into the script instead).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled, assertToolCallCountAtMost } from './_asserts';
import { CODE_RUN_BATCH_CONTEXT } from './_overrides';

export const SU_S13_CODE_RUN_BATCH: Scenario = {
  id: 'su-S13-code-run-batch',
  version: 2,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer: for the papercusp harness, go through all 12 open work items and return only the blocked ids and reasons, without bringing all item-detail rows into the conversation context. work_items:list omits state. The engineer should use ONE code:run orchestration script that bulk-fetches details with work_items:get { ids:[…] } and returns only the filtered summary, rather than hand-looping work_items:get or returning the whole bulk payload.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: CODE_RUN_BATCH_CONTEXT,
  asserts: [
    assertToolCalled(['code:run'], {
      name: 'reaches-for-code-run-on-batch',
      claim:
        'Expected the engineer to keep the 12-row detail payload out of model context with ONE code:run ' +
        'orchestration script — code:run was never called.',
      suggestion:
        'Use one code:run script that calls tools.work_items.get({ ids }) and returns only the blocked ids/reasons.',
    }),
    assertToolCallCountAtMost(['work_items:get'], 2, {
      name: 'does-not-hand-loop-per-item-get',
      claim:
        'The engineer hand-looped work_items:get one call at a time instead of batching the loop ' +
        'into a code:run script — exactly the sequential-turn/intermediate-context cost code:run removes.',
      suggestion:
        'Do the per-item get inside a code:run loop; a couple of direct probe gets are fine, but the bulk should run in the script.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S13_CODE_RUN_BATCH;
