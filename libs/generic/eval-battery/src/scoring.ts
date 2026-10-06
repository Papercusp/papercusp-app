/**
 * Pure scoring cores for the frozen LLM judge (factored out of the gym's
 * `judge-scoring.ts` into the shared eval-battery engine — reconciliation D-001).
 *
 * The judge reads a distilled trace and scores three dimensions with generic,
 * judgment-based reasoning — not a rigid anchor table. The weighted `composite` is
 * THE optimization reward. The rubric (model + temperature + weights + dimension
 * definitions) is frozen per run, and `rubricHash` is the key for re-judge-from-cache:
 * any change that would change a score changes the hash, so cached scores under an old
 * hash are never silently mixed with a new rubric.
 *
 * The rubric is subject-neutral: the gym supplies its coding rubric (`GYM_JUDGE_RUBRIC_V1`),
 * the Apiary supplies its instance rubric — the engine only sees a `BatteryRubric`.
 */
import { createHash } from 'node:crypto';
import { captureSourceHash } from './source-identity';

export const SCORING_SOURCE_HASH = captureSourceHash(import.meta.url);

export interface DimensionWeights {
  d1: number;
  d2: number;
  d3: number;
}

export interface JudgeDimensionScores {
  d1: number;
  d2: number;
  d3: number;
}

export interface BatteryRubric {
  /** Bump to deliberately invalidate the cache / start a new comparison basis. */
  version: string;
  /** Frozen judge model. */
  model: string;
  /** Pinned sampling temperature. Recorded for audit; not sent for opus models. */
  temperature: number;
  /** Extended-thinking budget for the judge ("extra-high thinking"). */
  thinkingBudgetTokens: number;
  /** Frozen dimension weights; composite = weight-normalized aggregate. */
  weights: DimensionWeights;
  /** The dimension definitions the judge reasons against (D1 primary). */
  dimensions: { d1: string; d2: string; d3: string };
}

/** Score range the judge emits per dimension. */
const MIN_SCORE = 0;
const MAX_SCORE = 10;

/**
 * Canonical sha256 over everything that would change a score. Built field-by-field
 * in a fixed order so object key ordering of the input never affects the hash.
 */
export function rubricHash(r: BatteryRubric): string {
  const payload = JSON.stringify({
    version: r.version,
    model: r.model,
    temperature: r.temperature,
    weights: { d1: r.weights.d1, d2: r.weights.d2, d3: r.weights.d3 },
    dimensions: { d1: r.dimensions.d1, d2: r.dimensions.d2, d3: r.dimensions.d3 },
  });
  return createHash('sha256').update(payload).digest('hex');
}

/** The reward: the weight-normalized aggregate of the three dimension scores. */
export function composite(scores: JudgeDimensionScores, weights: DimensionWeights): number {
  // A reward weight is never negative: the composite is a convex combination of
  // per-dimension scores, which only stays inside the [MIN_SCORE, MAX_SCORE] range
  // when every weight is >= 0. A negative weight would let a positive weight-sum
  // pass the `sum <= 0` guard yet produce an out-of-range reward (e.g. weights
  // {5,-1,-1} sum to 3 but yield 50/3 > MAX_SCORE), silently corrupting the
  // optimization signal. Reject it up front.
  if (weights.d1 < 0 || weights.d2 < 0 || weights.d3 < 0) {
    throw new Error('composite: weights must be non-negative');
  }
  const sum = weights.d1 + weights.d2 + weights.d3;
  if (sum <= 0) throw new Error('composite: weights must sum to a positive number');
  return (scores.d1 * weights.d1 + scores.d2 * weights.d2 + scores.d3 * weights.d3) / sum;
}

export interface ParsedJudgeOutput {
  d1: number;
  d2: number;
  d3: number;
  rationale: string;
}

function clampScore(v: number): number {
  return Math.min(MAX_SCORE, Math.max(MIN_SCORE, v));
}

/** Validate + clamp the judge's structured output. Throws (with the offending field) on garbage. */
export function parseJudgeOutput(raw: unknown): ParsedJudgeOutput {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`judge output must be a JSON object, got: ${typeof raw}`);
  }
  const o = raw as Record<string, unknown>;
  const dims: Array<keyof JudgeDimensionScores> = ['d1', 'd2', 'd3'];
  const scores = {} as JudgeDimensionScores;
  for (const dim of dims) {
    const v = o[dim];
    // Reject any non-finite score: NaN AND ±Infinity are garbage. Without the
    // finiteness check, clampScore(Infinity) === MAX_SCORE and
    // clampScore(-Infinity) === MIN_SCORE, so a non-finite judge output would
    // silently masquerade as a perfect / zero score instead of being rejected.
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`judge output dimension "${dim}" must be a finite number, got: ${JSON.stringify(v)}`);
    }
    scores[dim] = clampScore(v);
  }
  if (typeof o.rationale !== 'string') {
    throw new Error('judge output must include a string "rationale" (the proposer reflects on it)');
  }
  return { ...scores, rationale: o.rationale };
}
