/**
 * SU-S15 — code:run adoption at a SMALL batch (code-execution-tool-orchestration B-CX-3).
 *
 * Question: three independent per-item calls emitted together are already ONE
 * inference turn even though the transport performs three RPCs. Does the
 * engineer either use the native bulk `ids` form, use `code:run`, OR issue the
 * direct calls together, without serial model turns?
 *
 * Load-bearing assert: code:run OR all three direct gets in one model turn.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertCodeRunOrBulkOrSingleTurnFanout } from './_asserts';
import { SMALL_BATCH_CONTEXT } from './_overrides';

export const SU_S15_CODE_RUN_SMALL_BATCH: Scenario = {
  id: 'su-S15-code-run-small-batch',
  version: 2,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to check three specific work items and report which are blocked. Efficient answers use one native work_items:get { ids:[…] } bulk read, one code:run summary, or emit all three independent work_items:get calls together in one model turn; three downstream RPCs in one assistant response are not three inference round-trips.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 180, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: SMALL_BATCH_CONTEXT,
  asserts: [
    assertCodeRunOrBulkOrSingleTurnFanout(['work_items:get'], 3, {
      name: 'uses-one-inference-turn-for-small-fanout',
      claim: 'The engineer spread three independent gets across model turns. Use native bulk ids, code:run, or emit all three calls together.',
      suggestion: 'Optimize inference turns: one bulk get, one code:run, or three parallel tool calls in one response.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S15_CODE_RUN_SMALL_BATCH;
