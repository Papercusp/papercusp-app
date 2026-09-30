/**
 * SU-S01 — harness-scope.
 *
 * Question: at operator (no-harness) scope, when a user asks a vague
 * "show me the plan / the docs" question, does the engineer DECIDE the
 * scope and pass a `harness` arg (`'all'` for Papercusp's own plans/docs,
 * else a slug) rather than stalling on `harness_required`?
 *
 * This is the exact confusion the playbook's "Scope" section fixes: a
 * missing harness is "you haven't said which yet, so decide and pass it",
 * never "this session can't".
 *
 * A `toolOverride` (HARNESS_REQUIRED_GATE) returns `harness_required` for any
 * docs / plans call that omits a `harness` arg, so the scenario actually
 * exercises the recover-or-stall behavior rather than letting the benign stub
 * mask it.
 *
 * Load-bearing assert (ERROR): a docs or plans call carried a non-empty
 * `harness` arg (passed up front, or on recovery from the gate). Secondary
 * (warn): the reply doesn't fall back to give-up language.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolGroupWithStringArg } from './_asserts';
import { HARNESS_REQUIRED_GATE } from './_overrides';

export const SU_S01_HARNESS_SCOPE: Scenario = {
  id: 'su-S01-harness-scope',
  version: 2,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer, working at operator (no-harness) scope, asks the engineer to bring them up to speed on the spec-md deprecation cleanup work — they want to see the relevant plan and the related docs. They do not name a harness slug; they just want a quick orientation on where that work stands.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  // docs:*/plans:* return harness_required unless a harness arg is passed.
  toolOverride: HARNESS_REQUIRED_GATE,
  asserts: [
    assertToolGroupWithStringArg(['docs', 'plans'], 'harness', {
      name: 'docs-or-plans-with-harness-scope',
      claim:
        'Expected a docs:* or plans:* call carrying a non-empty `harness` scope arg ' +
        "(the engineer should decide the scope — `'all'` or a slug — up front or on recovery, not stall on harness_required).",
      suggestion:
        "Playbook 'Scope': a missing harness means decide + pass one (harness:'all' for Papercusp's own docs/plans).",
    }),
    // Soft signal: the engineer shouldn't give up citing a missing harness.
    {
      kind: 'text_excludes',
      pattern: /\b(can'?t|cannot|unable to)\b[^.!?]{0,40}\b(harness|plan|doc)/i,
    },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S01_HARNESS_SCOPE;
