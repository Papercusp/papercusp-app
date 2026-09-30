/**
 * PAIRED comparison of embedder legs scored on one gold set
 * (prose-embedding-384-untrained-mrl-fix D-002).
 *
 * `embedder-eval-cli` emits per-leg CLASS MEANS plus a per-query row for every
 * query. The class means alone cannot answer the only question the bench
 * exists to settle — "is this difference outside noise?" — because that is a
 * PAIRED question: every leg sees the same corpus and the same queries, and
 * only the embedder varies. Two rounded aggregates support eyeballing, not a
 * verdict.
 *
 * So this module consumes the per-query rows and reports, per class:
 *
 *  - **delta MRR** with a paired bootstrap CI, resampling QUERIES (not the two
 *    legs independently) so shared per-query difficulty cancels. This is the
 *    PRIMARY verdict D-002 binds P-002/P-003 to.
 *  - **hit@1** via McNemar's exact test, which reads only the queries where
 *    the legs actually disagree.
 *  - **rho**, the observed correlation between the legs — reported rather than
 *    assumed, because it is what governs the interval width.
 *  - **mde80**, the effect this sample would have caught 80% of the time.
 *
 * The last one carries the interpretation rule: a null here means "no
 * decision-relevant loss detected at this power", NEVER "the legs are
 * equivalent". `verdict` encodes exactly that distinction so a caller cannot
 * accidentally report an underpowered null as proven equivalence — the failure
 * mode D-002 §4 names as the most likely way this plan reaches a confidently
 * wrong conclusion, since it terminates the work cheaply and looks like a
 * finding.
 */
import { pairedBootstrapCI, mcnemarExact, type PairedComparison, type McNemarResult } from '@papercusp/bench-metrics';

/** One row of `embedder-eval-cli`'s per-leg `perQuery` output. */
export interface PerQueryRow {
  id: string;
  class: string;
  firstRelevantRank: number;
  reciprocalRank: number;
  top1Score: number;
}

/** Classes that have a correct answer in the corpus (hard negatives do not). */
export const ANSWERABLE_CLASSES = ['lexical-gap', 'exact-identifier', 'session-start-intent'] as const;

/** The pooled pseudo-class covering every answerable query. */
export const ALL_ANSWERABLE = 'ALL_ANSWERABLE';

export type Verdict =
  /** The CI excludes zero: a real difference at this confidence level. */
  | 'candidate-better'
  | 'candidate-worse'
  /**
   * The CI includes zero AND is tight enough that a decision-relevant effect
   * would have shown. The honest phrasing is still "no decision-relevant loss
   * detected at this power" — not "equivalent".
   */
  | 'no-detected-difference'
  /**
   * The CI includes zero but is too wide to rule anything out: this class
   * cannot support a verdict either way, and saying "no difference" here would
   * be reporting the absence of power as the presence of evidence.
   */
  | 'underpowered';

export interface ClassComparison {
  /** Paired queries in this class. */
  n: number;
  baselineMrr: number;
  candidateMrr: number;
  /** Paired bootstrap CI on (candidate − baseline) mean reciprocal rank. */
  deltaMrr: PairedComparison;
  baselineRecallAt1: number;
  candidateRecallAt1: number;
  /** McNemar's exact test on hit@1 (only discordant queries carry evidence). */
  hitAt1: McNemarResult;
  verdict: Verdict;
  /**
   * The sentence a report should use. Pre-composed here precisely so the
   * "within noise ⇒ equivalent" slip cannot be reintroduced downstream by
   * someone paraphrasing a bare number.
   */
  statement: string;
}

export interface LegComparison {
  baseline: string;
  candidate: string;
  byClass: Record<string, ClassComparison>;
}

function round(x: number, places = 4): number {
  return +x.toFixed(places);
}

/**
 * Effect size (in delta-MRR) considered worth acting on. D-002 branch (c)
 * proposes a vector(384)→vector(512) migration across five surfaces and 20k+
 * vectors — worth doing only on a LARGE effect — so a CI that rules out
 * anything bigger than this is a genuine, decision-relevant null rather than
 * a shrug.
 */
export const DECISION_RELEVANT_DELTA_MRR = 0.03;

function classify(cmp: PairedComparison, decisionRelevant: number): Verdict {
  if (cmp.significant) return cmp.delta.point > 0 ? 'candidate-better' : 'candidate-worse';
  // A null is only meaningful if the interval was tight enough to have seen a
  // difference that would have changed the decision.
  return cmp.halfWidth <= decisionRelevant ? 'no-detected-difference' : 'underpowered';
}

function statementFor(cls: string, v: Verdict, cmp: PairedComparison, decisionRelevant: number): string {
  const d = round(cmp.delta.point);
  const lo = round(cmp.delta.lower);
  const hi = round(cmp.delta.upper);
  const ci = `95% CI [${lo}, ${hi}]`;
  switch (v) {
    case 'candidate-better':
      return `${cls}: candidate is BETTER by ${d} MRR, ${ci} (n=${cmp.n}, rho=${round(cmp.rho, 3)}).`;
    case 'candidate-worse':
      return `${cls}: candidate is WORSE by ${round(Math.abs(cmp.delta.point))} MRR, ${ci} (n=${cmp.n}, rho=${round(cmp.rho, 3)}).`;
    case 'no-detected-difference':
      return (
        `${cls}: no decision-relevant difference detected at this power — delta ${d} MRR, ${ci}, ` +
        `which rules out effects larger than ±${round(cmp.halfWidth)} (80%-power MDE ${round(cmp.mde80)}; ` +
        `decision-relevant threshold ${decisionRelevant}). This is NOT a finding of equivalence.`
      );
    case 'underpowered':
      return (
        `${cls}: UNDERPOWERED — delta ${d} MRR, ${ci}. The interval is wider than the ` +
        `decision-relevant threshold ${decisionRelevant}, so this class supports no verdict in either ` +
        `direction; more queries are needed before it can rule.`
      );
  }
}

/**
 * Group per-query rows by class, plus the pooled ALL_ANSWERABLE pseudo-class.
 * Hard negatives are excluded: they have no correct answer, so their
 * reciprocal rank is identically 0 for every leg and pooling them would dilute
 * every delta toward zero — i.e. manufacture a null.
 */
function answerableByClass(rows: readonly PerQueryRow[]): Map<string, PerQueryRow[]> {
  const answerable = new Set<string>(ANSWERABLE_CLASSES);
  const out = new Map<string, PerQueryRow[]>();
  const push = (key: string, row: PerQueryRow): void => {
    const bucket = out.get(key);
    if (bucket) bucket.push(row);
    else out.set(key, [row]);
  };
  for (const r of rows) {
    if (!answerable.has(r.class)) continue;
    push(r.class, r);
    push(ALL_ANSWERABLE, r);
  }
  return out;
}

/**
 * Compare a candidate leg against a baseline leg on their per-query rows.
 *
 * Rows are aligned BY QUERY ID, never by position. Both legs score the same
 * frozen gold set so the orders do coincide today — but a positional join
 * would fail silently and invisibly the first time they didn't (a filtered
 * leg, a re-ordered fixture), pairing unrelated queries and reporting the
 * resulting garbage with a confident CI attached.
 */
export function compareLegs(
  baselineName: string,
  baselineRows: readonly PerQueryRow[],
  candidateName: string,
  candidateRows: readonly PerQueryRow[],
  opts: { seed?: number; iterations?: number; decisionRelevantDeltaMrr?: number } = {},
): LegComparison {
  const decisionRelevant = opts.decisionRelevantDeltaMrr ?? DECISION_RELEVANT_DELTA_MRR;
  const candidateById = new Map(candidateRows.map((r) => [r.id, r]));

  const baseByClass = answerableByClass(baselineRows);
  const byClass: Record<string, ClassComparison> = {};

  for (const [cls, rows] of baseByClass) {
    const baseRr: number[] = [];
    const candRr: number[] = [];
    const baseHit: boolean[] = [];
    const candHit: boolean[] = [];
    for (const r of rows) {
      const c = candidateById.get(r.id);
      if (!c) {
        throw new Error(`compareLegs: query '${r.id}' present in ${baselineName} but missing from ${candidateName}`);
      }
      baseRr.push(r.reciprocalRank);
      candRr.push(c.reciprocalRank);
      baseHit.push(r.firstRelevantRank === 1);
      candHit.push(c.firstRelevantRank === 1);
    }
    const deltaMrr = pairedBootstrapCI(baseRr, candRr, { seed: opts.seed, iterations: opts.iterations });
    const verdict = classify(deltaMrr, decisionRelevant);
    byClass[cls] = {
      n: baseRr.length,
      baselineMrr: round(deltaMrr.meanA),
      candidateMrr: round(deltaMrr.meanB),
      deltaMrr,
      baselineRecallAt1: round(baseHit.filter(Boolean).length / Math.max(baseHit.length, 1)),
      candidateRecallAt1: round(candHit.filter(Boolean).length / Math.max(candHit.length, 1)),
      hitAt1: mcnemarExact(baseHit, candHit),
      verdict,
      statement: statementFor(cls, verdict, deltaMrr, decisionRelevant),
    };
  }

  return { baseline: baselineName, candidate: candidateName, byClass };
}

/**
 * Whether the per-class verdicts DISAGREE IN SIGN among classes that actually
 * reached one. D-002 §5: exact-identifier is 90 of 122 answerable queries, so
 * ALL_ANSWERABLE is identifier-dominated; if the classes point opposite ways
 * the pooled number is uninterpretable and must be reported as such rather
 * than quoted as the answer.
 */
export function classesDisagree(cmp: LegComparison): boolean {
  const signs = new Set<string>();
  for (const [cls, row] of Object.entries(cmp.byClass)) {
    if (cls === ALL_ANSWERABLE) continue;
    if (row.verdict === 'candidate-better') signs.add('+');
    if (row.verdict === 'candidate-worse') signs.add('-');
  }
  return signs.size > 1;
}
