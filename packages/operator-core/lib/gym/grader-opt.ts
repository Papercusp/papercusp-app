/**
 * Grader-optimization phase (P-030 — importance low, Phase 6).
 *
 * A SEPARATE optimization run with an INVERTED objective: instead of producer quality,
 * optimize the GRADERS (validator/crosscheck/tester) for RECALL on held-out planted
 * defects — catch MORE, NEVER fewer. The "never fewer" monotonic constraint is the
 * anti-degeneracy guard (a grader that catches less is rejected outright, regardless of
 * recall math). The external Opus judge is the arbiter of grade quality elsewhere; this
 * is the pure deterministic objective.
 */

function dedupe(xs: readonly string[]): Set<string> {
  return new Set(xs);
}

/** Fraction of planted defects the grader caught: |caught ∩ planted| / |planted|. */
export function graderRecall(caught: readonly string[], planted: readonly string[]): number {
  const p = dedupe(planted);
  if (p.size === 0) return 0;
  const c = dedupe(caught);
  let hit = 0;
  for (const d of p) if (c.has(d)) hit++;
  return hit / p.size;
}

export interface GraderObjective {
  recall: number;
  /** True iff the candidate caught EVERY defect the baseline caught (never fewer). */
  monotonic: boolean;
  /** Accept iff monotonic AND recall ≥ baseline recall. */
  accept: boolean;
}

export function evaluateGraderCandidate(
  candidateCaught: readonly string[],
  baselineCaught: readonly string[],
  planted: readonly string[],
): GraderObjective {
  const cand = dedupe(candidateCaught);
  const monotonic = [...dedupe(baselineCaught)].every((d) => cand.has(d));
  const recall = graderRecall(candidateCaught, planted);
  const baselineRecall = graderRecall(baselineCaught, planted);
  return { recall, monotonic, accept: monotonic && recall >= baselineRecall };
}
