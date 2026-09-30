/**
 * The eval harness over {@link ./metrics} — turn a RANKED LIST plus a way to
 * judge it into a relevance verdict.
 *
 * `metrics.ts` shipped the formulas (nDCG@10, P@5, acc@5) and nothing in either
 * consumer repo ever called them: a metric contract with no harness is a
 * calculator, not an eval. This is the harness half.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS ADDS `recallAtK` — the shipped metrics CANNOT SEE A MISS
 *
 * Every function in `metrics.ts` scores only the list it is handed. `ndcg`
 * normalises against the ideal ordering OF THOSE SAME GRADES, so a list that is
 * perfectly ordered scores **1.0 whether it contains all of the relevant
 * documents or one of them**. `precisionAtK` and `accessoryAtK` are likewise
 * within-list. That is correct for what they measure — ORDERING and POLLUTION —
 * and it makes the whole family structurally blind to RECALL.
 *
 * Which is the half of a search failure users actually report. "The search did
 * not find the conversation I remember" is a recall complaint, and pinning it
 * with nDCG alone yields a metric that stays green through exactly the
 * regression it was added to catch.
 *
 * So recall is measured against an EXTERNALLY KNOWN relevant set, and it is the
 * one number here that cannot be computed from the ranking alone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `coverage` IS A FIELD AND NOT A COMMENT
 *
 * Both failure directions of this harness produce a number that LOOKS like a
 * verdict:
 *
 *   - an empty ranking scores `ndcg → 0`, indistinguishable from "retrieval
 *     worked and everything it found was irrelevant";
 *   - a list where nothing is relevant ALSO scores 0 (`idcg === 0`);
 *   - and a recall of 0 computed against an EMPTY ground-truth set means "there
 *     was nothing to find", not "we found nothing" — the opposite verdict.
 *
 * A caller that reads only the scores cannot tell these apart, and each one
 * reads as failure when it may be vacuity. So `coverage` states which case this
 * is, `recallAtK` is `null` rather than `0` when no ground truth was supplied,
 * and {@link assertRelevance} refuses a non-`complete` evaluation instead of
 * comparing its scores to a floor. Same rule as any absence-vs-emptiness
 * report: a zero is only evidence once you know the measurement ran.
 *
 * Pure and domain-free — no corpus, no store, no query language. The caller
 * supplies the judgement, which is what lets a judgement be DERIVED (a term
 * overlap, a provenance check, a substring scan of the corpus) instead of
 * hand-authored qrels that rot as the corpus grows.
 */

import { accessoryAtK, ndcgAtK, precisionAtK } from './metrics';

/**
 * Whether this evaluation MEASURED anything.
 *
 * - `complete` — the ranking was scored; the numbers mean what they say.
 * - `empty-ranking` — retrieval returned nothing. Every score is 0 by vacuity.
 * - `no-ground-truth` — a relevant set was declared but is EMPTY, so recall has
 *   no referent. Ordering/pollution scores are still meaningful; recall is not.
 *
 * `empty-ranking` wins when both apply: nothing was returned, so nothing about
 * this run is informative.
 */
export type RelevanceEvalCoverage = 'complete' | 'empty-ranking' | 'no-ground-truth';

/** The externally-known relevant set recall is measured against. */
export interface RelevanceGroundTruth<T> {
  /** Ids that SHOULD appear. Derive these where you can; hand-written qrels rot. */
  ids: readonly string[];
  /** How to read the comparable id off a ranked item. */
  idOf: (item: T) => string;
}

export interface RelevanceEvalInput<T> {
  ranked: readonly T[];
  /** Judge one result, 0..3 (the metric contract's scale). */
  grade: (item: T) => number;
  /** Cutoff for every @k metric. Default 10, matching the harness's nDCG@10. */
  k?: number;
  /** Omit when the query has no known relevant set — recall then reports null. */
  groundTruth?: RelevanceGroundTruth<T>;
  /** grade >= this counts as relevant for precision. Default 2 (the harness's P@5). */
  precisionThreshold?: number;
  /** grade <= this counts as pollution. Default 1 (the harness's acc@5). */
  accessoryThreshold?: number;
}

export interface RelevanceEvalResult {
  coverage: RelevanceEvalCoverage;
  k: number;
  /** Derived grades in RANK ORDER — the input to every metric below. */
  grades: number[];
  ndcgAtK: number;
  precisionAtK: number;
  accessoryAtK: number;
  /**
   * Fraction of the ground-truth ids present in the top `k`.
   *
   * ⚠ `null` — never 0 — when no ground truth was supplied or it was empty. A
   * 0 here would read as "found none of them", the strongest possible failure
   * claim, from a run that had nothing to find.
   */
  recallAtK: number | null;
  /** Ground-truth ids found in the top `k`. */
  foundIds: string[];
  /** Ground-truth ids ABSENT from the top `k` — the actionable half of recall. */
  missingIds: string[];
}

/**
 * Fraction of `relevantIds` that appear in the first `k` of `retrievedIds`.
 *
 * The metric `metrics.ts` deliberately has no analogue of, because unlike the
 * others it cannot be computed from the ranking alone. Returns `null` for an
 * empty relevant set — see the `recallAtK` note above.
 */
export function recallAtK(
  retrievedIds: readonly string[],
  relevantIds: readonly string[],
  k = 10,
): number | null {
  const relevant = new Set(relevantIds);
  if (relevant.size === 0) return null;
  const top = new Set(retrievedIds.slice(0, k));
  let found = 0;
  for (const id of relevant) if (top.has(id)) found++;
  return found / relevant.size;
}

/** Score a ranked list. Pure; the caller owns the judgement. */
export function evaluateRelevance<T>(input: RelevanceEvalInput<T>): RelevanceEvalResult {
  const {
    ranked,
    grade,
    k = 10,
    groundTruth,
    precisionThreshold = 2,
    accessoryThreshold = 1,
  } = input;

  const grades = ranked.map(grade);
  const topIds = groundTruth ? ranked.slice(0, k).map(groundTruth.idOf) : [];
  const truthIds = groundTruth ? [...new Set(groundTruth.ids)] : [];
  const inTop = new Set(topIds);

  const coverage: RelevanceEvalCoverage =
    ranked.length === 0
      ? 'empty-ranking'
      : groundTruth && truthIds.length === 0
        ? 'no-ground-truth'
        : 'complete';

  return {
    coverage,
    k,
    grades,
    ndcgAtK: ndcgAtK(grades, k),
    precisionAtK: precisionAtK(grades, k, precisionThreshold),
    accessoryAtK: accessoryAtK(grades, k, accessoryThreshold),
    recallAtK: groundTruth ? recallAtK(topIds, truthIds, k) : null,
    foundIds: truthIds.filter((id) => inTop.has(id)),
    missingIds: truthIds.filter((id) => !inTop.has(id)),
  };
}

/** A relevance floor: every stated bound must hold, or the eval FAILS. */
export interface RelevanceFloor {
  minNdcgAtK?: number;
  minPrecisionAtK?: number;
  minRecallAtK?: number;
  /** Upper bound — pollution is the one metric where MORE is worse. */
  maxAccessoryAtK?: number;
}

export interface RelevanceAssertion {
  ok: boolean;
  /** Human-readable reasons the floor was not met; empty when `ok`. */
  failures: string[];
  result: RelevanceEvalResult;
}

/**
 * Compare an evaluation to a floor, REFUSING a run that measured nothing.
 *
 * A vacuous run is reported as a failure rather than compared to the floor, and
 * this is the whole point of the function: `coverage: 'empty-ranking'` scores
 * zero on every metric, so a floor check would "correctly" fail it with a
 * message about relevance — sending the reader to tune ranking when retrieval
 * returned nothing at all. `no-ground-truth` is the mirror image: it would
 * silently PASS any `minRecallAtK` (there is nothing to miss), which is the
 * dangerous direction — a regression test that cannot fail.
 */
export function assertRelevance(
  result: RelevanceEvalResult,
  floor: RelevanceFloor,
): RelevanceAssertion {
  const failures: string[] = [];

  if (result.coverage === 'empty-ranking') {
    failures.push(
      'VACUOUS: retrieval returned no results, so every score is 0 by vacuity — ' +
        'this is a retrieval failure, not a relevance one. Scores not compared to the floor.',
    );
  } else if (result.coverage === 'no-ground-truth' && floor.minRecallAtK !== undefined) {
    failures.push(
      'VACUOUS: minRecallAtK was requested but the ground-truth set is EMPTY, so ' +
        'recall has no referent and this check could never fail. Fix the ground-truth ' +
        'derivation before trusting this eval.',
    );
  } else {
    const { minNdcgAtK, minPrecisionAtK, minRecallAtK, maxAccessoryAtK } = floor;
    if (minNdcgAtK !== undefined && result.ndcgAtK < minNdcgAtK) {
      failures.push(`nDCG@${result.k} ${result.ndcgAtK.toFixed(4)} < floor ${minNdcgAtK}`);
    }
    if (minPrecisionAtK !== undefined && result.precisionAtK < minPrecisionAtK) {
      failures.push(`P@${result.k} ${result.precisionAtK.toFixed(4)} < floor ${minPrecisionAtK}`);
    }
    if (maxAccessoryAtK !== undefined && result.accessoryAtK > maxAccessoryAtK) {
      failures.push(`accessory@${result.k} ${result.accessoryAtK} > ceiling ${maxAccessoryAtK}`);
    }
    if (minRecallAtK !== undefined) {
      // Unreachable via the branch above, but a null here would otherwise
      // compare as false and read as a relevance failure.
      if (result.recallAtK === null) {
        failures.push('VACUOUS: minRecallAtK requested but no ground truth was supplied.');
      } else if (result.recallAtK < minRecallAtK) {
        failures.push(
          `recall@${result.k} ${result.recallAtK.toFixed(4)} < floor ${minRecallAtK} — ` +
            `missing ${result.missingIds.length}: ${result.missingIds.slice(0, 5).join(', ')}`,
        );
      }
    }
  }

  return { ok: failures.length === 0, failures, result };
}
