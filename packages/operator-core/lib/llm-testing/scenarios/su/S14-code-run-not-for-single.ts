/**
 * SU-S14 — no code:run over-application on a single call
 * (code-execution-tool-orchestration B-CX-3, the nudge's "NOT WHEN" guard).
 *
 * Question: the CODE_RUN_NUDGE tells the engineer to reach for `code:run` on a
 * MANY-tool-call loop — but explicitly NOT for a single tool call. Does the
 * engineer respect that, answering a one-shot factual question with a single
 * direct tool call instead of wrapping it in a code:run script?
 *
 * The user asks a single-fact question (the status of the sheets harness),
 * answerable by ONE `harness:status` call. Wrapping it in `code:run` is the
 * over-application failure the guard catches — it adds the script-authoring
 * overhead the feature is meant to AVOID on single calls.
 *
 * Load-bearing assert (ERROR): `harness:status` is called and `code:run` is NOT.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled, assertToolNotCalled } from './_asserts';
import { HARNESS_STATUS_RESULT } from './_overrides';

export const SU_S14_CODE_RUN_NOT_FOR_SINGLE: Scenario = {
  id: 'su-S14-code-run-not-for-single',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    "A developer asks the engineer for the current status of the sheets harness — a single-fact question answerable by one harness:status call. The engineer should call harness:status directly and answer, NOT wrap a single tool call in a code:run orchestration script (the CODE_RUN_NUDGE's explicit 'NOT WHEN: a single tool call' rule).",
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 120, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: HARNESS_STATUS_RESULT,
  asserts: [
    assertToolCalled(['harness:status'], {
      name: 'answers-single-fact-directly',
      claim: 'Expected a direct harness:status call to answer the single-fact status question.',
      suggestion: 'For a one-shot factual lookup, call the tool directly.',
    }),
    assertToolNotCalled(['code:run'], {
      name: 'no-code-run-for-single-call',
      claim:
        'The engineer wrapped a single tool call in a code:run script — over-applying code:run on the ' +
        "exact case the nudge excludes ('NOT WHEN: a single tool call').",
      suggestion:
        'code:run is for a loop/branch/fan-out over MANY calls. A single lookup is a direct tool call.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S14_CODE_RUN_NOT_FOR_SINGLE;
