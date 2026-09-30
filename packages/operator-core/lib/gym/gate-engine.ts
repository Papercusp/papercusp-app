/**
 * Accept/reject gate engine (P-018) — turns a candidate's full eval results + the
 * parent/champion baselines into the gate decision (via the pure predicates in
 * gates.ts), and selects the next parent from the frontier.
 *
 * The frontier prune + champion update live in the loop driver (P-022) using
 * frontier.ts; this module is the per-candidate decision + parent pick.
 */
import { comparisonEvidence, evaluateGates, type DeterministicEvidence, type GatesVerdict } from './gates';

export interface VariantEval {
  variantId: string;
  /** Mean judge composite on the train pool (the reward). */
  trainAgg: number;
  /** Per-task-category train composites (for the Pareto frontier). */
  trainVector: number[];
  /** Aggregate on the frozen dev-anchor. */
  devAnchorAgg: number;
  /**
   * Aggregate on the `real-anchor` pool — real shipped features replayed at their
   * pre-implementation commit (P-028/D-014). Scored every cycle and, before P-002,
   * excluded from every aggregate; it now GATES promotion (D-004 condition 3).
   */
  realAnchorAgg: number;
  /**
   * Was this variant's real-anchor aggregate actually measured? Coverage-only
   * evidence (P-002) — `not-measured` when the variant ran against no real-anchor
   * task, or a real-anchor task produced no score. Never a `fail`: a real regression
   * is the margin's verdict, not the coverage's.
   */
  realAnchorEvidence: DeterministicEvidence;
  /** Mean cost per run. */
  meanCost: number;
  /**
   * Did any run break the repo's pre-existing tests? Three-state evidence (P-003):
   * a run that never reported the signal is `not-measured`, never a silent pass.
   */
  regressionEvidence: DeterministicEvidence;
  /** Were all planted bugs caught? Three-state evidence (P-003). */
  probeEvidence: DeterministicEvidence;
}

export interface AcceptThresholds {
  /** Train improvement margin (variance-derived, P-014). */
  epsilon: number;
  /** Dev-anchor regression slack (variance-derived, P-014). */
  delta: number;
  /** Cost guardrail multiplier. */
  costCeiling: number;
}

export function decideAccept(
  candidate: VariantEval,
  parent: VariantEval,
  champion: VariantEval,
  baselineMeanCost: number,
  t: AcceptThresholds,
): GatesVerdict {
  return evaluateGates({
    candidateJudgeAgg: candidate.trainAgg,
    parentJudgeAgg: parent.trainAgg,
    epsilon: t.epsilon,
    candidateDevAnchorAgg: candidate.devAnchorAgg,
    championDevAnchorAgg: champion.devAnchorAgg,
    delta: t.delta,
    candidateRealAnchorAgg: candidate.realAnchorAgg,
    championRealAnchorAgg: champion.realAnchorAgg,
    // P-002: the comparison is only measured when BOTH sides are. A champion that was
    // never scored on the real-anchor gives the candidate nothing to be no-worse-than,
    // so the gate reports a gap rather than a pass on one side's number alone.
    realAnchorEvidence: comparisonEvidence(candidate.realAnchorEvidence, champion.realAnchorEvidence),
    regressionEvidence: candidate.regressionEvidence,
    probeEvidence: candidate.probeEvidence,
    candidateMeanCost: candidate.meanCost,
    baselineMeanCost,
    costCeiling: t.costCeiling,
  });
}

/**
 * Select the next parent from the frontier, biased toward the under-served member —
 * v1 proxy: the lowest train aggregate (most headroom). Deterministic (tie-break id).
 */
export function selectParent<T extends { variantId: string; trainAgg: number }>(frontier: readonly T[]): T | null {
  let best: T | null = null;
  for (const v of frontier) {
    if (best === null || v.trainAgg < best.trainAgg || (v.trainAgg === best.trainAgg && v.variantId < best.variantId)) {
      best = v;
    }
  }
  return best;
}
