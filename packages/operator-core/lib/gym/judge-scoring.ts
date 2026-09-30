/**
 * The judge scoring core moved into the shared eval-battery engine (reconciliation
 * D-001). This module now re-exports the canonical cores from `@papercusp/eval-battery`
 * and keeps only the gym's OWN frozen rubric instance (`GYM_JUDGE_RUBRIC_V1`) — the
 * gym is the `HarnessSubject`, so its coding-specific dimension text lives here, not in
 * the subject-neutral engine.
 *
 * `GymJudgeRubric` is re-exported as an alias of the engine's `BatteryRubric` so the
 * gym's modules + the (still-live) apiary keep importing it unchanged.
 */
import type { BatteryRubric } from '@papercusp/eval-battery';
import { LEARNING_MODEL_SPEC } from '../learning/model-policy';

export {
  rubricHash,
  composite,
  parseJudgeOutput,
  type DimensionWeights,
  type JudgeDimensionScores,
  type ParsedJudgeOutput,
  type BatteryRubric as GymJudgeRubric,
} from '@papercusp/eval-battery';

/** The gym's frozen rubric — its coding-harness dimension definitions. */
export const GYM_JUDGE_RUBRIC_V1: BatteryRubric = {
  version: 'v1',
  model: LEARNING_MODEL_SPEC,
  temperature: 0,
  thinkingBudgetTokens: 32_000,
  // D1 is primary (the layer the harness's own tests don't cover).
  weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  dimensions: {
    d1:
      'Intent & spec fidelity (PRIMARY): did the work achieve the high-level INTENT, ' +
      'and was the spec itself gappy or misspecified given the project? Judge the layer ' +
      "the harness's own validator/tests do not cover — not literal spec conformance.",
    d2:
      'Code quality (subjective): clarity, minimality, convention-fit, and the absence of ' +
      'needless complexity or tech-debt in the produced diff.',
    d3:
      'Process correctness: did each role behave well — e.g. did the (mutable) validator ' +
      'catch real issues rather than rubber-stamp, did the worker avoid thrash. ' +
      'A quality observation, not a pass/fail gate.',
  },
};
