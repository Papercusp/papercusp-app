/**
 * rerank-decision.ts — the inferential core of the reranker INTEGRATION
 * benchmark (WI-37653, owner-directed 2026-08-10: "make a much better benchmark
 * of the reranker so we can properly decide how to integrate it" + "make sure it
 * has enough data to be conclusive").
 *
 * Split from the CLI for the reason `corpus-clarity-validity.ts` and
 * `paired-leg-report.ts` were: the CLI half talks to Postgres and the search
 * engine so none of it is unit-testable, and THESE functions are where the run's
 * conclusions are formed. A wrong statistic still looks like a statistic.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL — the defect it is built to not repeat
 *
 * D-093 closed P-008 ("rerank: measured and not adopted") on a run whose
 * headline was `known-item admitted 0/7 in both arms`. That decision record
 * states its own ceiling honestly: only **2 of 7** batches were `order-blocked`
 * (in the pool, lost on rank). The other 5 were NOT-RETRIEVED, which no
 * reordering can fix. So the effective sample was 2, and 0/2 is consistent with
 * a true rescue rate up to ~78% (rule of three). The null was a POWER FAILURE
 * being read as a finding.
 *
 * And more runs could not have fixed it: `wi-6512-replay.ts` REPLAY is a FIXED
 * 7-batch RECONSTRUCTION of one investigation session whose raw transcript is
 * gone. n=7 was the size of the entire fixture, not a sampling choice.
 *
 * Two design consequences, both encoded here rather than left to the reader:
 *
 *   1. EVERY null carries its MDE. `pairedDifference` reports the minimum
 *      effect the run could have detected, so "no effect" always reads as "no
 *      effect larger than X" and can never again be published as "no effect".
 *   2. STRATIFY BY OPPORTUNITY. Reranking is a REORDER: it can only act where
 *      the relevant row is in the pool but below the cut. Measuring it over
 *      unstratified traffic dilutes a real effect by 1/share and needs ~1/share²
 *      the samples to recover — which is exactly how a 2/7 signal vanished.
 */

/**
 * Where a query sits relative to what reranking can physically change.
 *
 * This is the same taxonomy `wi-6512-known-item-replay-cli.ts` prints
 * (ADMITTED · ORDER-blocked · FILTER-blocked · NOT-RETRIEVED); it lives here so
 * it is testable and so the two benches cannot drift apart on the one
 * classification the whole decision rests on.
 */
export type RerankOpportunity =
  /** Already above the cut without reranking. A reorder can only LOSE ground. */
  | 'admitted'
  /** In the candidate pool but below the cut. The ONLY stratum rerank can win. */
  | 'order-blocked'
  /** Never in the candidate pool. No reordering can conjure it. */
  | 'not-retrieved';

/**
 * Classify one query by where its known-relevant row landed in the CONTROL arm.
 *
 * `poolRank` is 0-based within the over-fetched candidate pool, or `null` when
 * retrieval never returned the row at all. `cut` is how many rows survive to the
 * consumer (the page size, or the slot count the char budget allows).
 *
 * ⚠ Classification MUST come from the control arm. Classifying on the treatment
 * arm's ranks would define the strata using the very reordering under test, so
 * a query would migrate between strata as a RESULT of the treatment and the
 * comparison would no longer be paired on a fixed population.
 */
export function classifyOpportunity(poolRank: number | null, cut: number): RerankOpportunity {
  if (poolRank === null || poolRank < 0) return 'not-retrieved';
  return poolRank < cut ? 'admitted' : 'order-blocked';
}

/** Two-sided 95% normal quantile. */
const Z_95 = 1.959963985;
/** One-sided normal quantile for 80% power. */
const Z_POWER_80 = 0.841621234;

export interface PairedDifference {
  /** Usable pairs (both arms present). */
  n: number;
  /** mean(treatment − control). Positive = treatment better. */
  meanDiff: number;
  /** Sample SD of the per-pair differences. */
  sdDiff: number;
  /** Standard error of `meanDiff`. */
  se: number;
  /** 95% CI for the true mean difference. */
  ci95: readonly [number, number];
  /**
   * MINIMUM DETECTABLE EFFECT at this n, alpha=0.05 two-sided, power=0.80.
   *
   * THE FIELD THIS MODULE EXISTS FOR. A null result is only interpretable
   * beside it: `meanDiff ≈ 0` with `mde80 = 0.01` is strong evidence of no
   * useful effect, while the same `meanDiff` with `mde80 = 0.35` is evidence of
   * nothing whatsoever. D-093 published the second shape as if it were the
   * first.
   */
  mde80: number;
  /**
   * True when the CI contains 0 AND the MDE is small enough that the null is
   * informative. `null` when the run simply lacked power to say anything —
   * deliberately NOT `false`, because "we could not tell" and "there is no
   * effect" are the two readings this whole file exists to keep apart.
   */
  nullIsInformative: boolean | null;
}

/**
 * Paired inference over per-query (control, treatment) outcomes.
 *
 * Paired because both arms run the SAME queries against the SAME corpus
 * instant: the per-query variance in retrieval difficulty is enormous compared
 * with the treatment effect, and an unpaired comparison spends all its power
 * measuring that instead.
 *
 * `informativeNullThreshold` is the effect size below which we would not care —
 * the caller's judgement, not a statistical constant. For nDCG, 0.02 (two
 * points) is a conventional floor for "worth shipping".
 *
 * Returns `null` when fewer than 3 pairs survive: an SD from 2 points is not a
 * measurement, and returning a plausible-looking object would invite exactly
 * the over-reading this module was built to prevent.
 */
export function pairedDifference(
  control: readonly number[],
  treatment: readonly number[],
  informativeNullThreshold = 0.02,
): PairedDifference | null {
  if (control.length !== treatment.length) return null;
  const diffs: number[] = [];
  for (let i = 0; i < control.length; i++) {
    const c = control[i];
    const t = treatment[i];
    if (typeof c !== 'number' || typeof t !== 'number') continue;
    if (!Number.isFinite(c) || !Number.isFinite(t)) continue;
    diffs.push(t - c);
  }
  const n = diffs.length;
  if (n < 3) return null;

  const meanDiff = diffs.reduce((a, b) => a + b, 0) / n;
  // Bessel-corrected: these are a SAMPLE of possible queries, not the population.
  const variance = diffs.reduce((acc, d) => acc + (d - meanDiff) ** 2, 0) / (n - 1);
  const sdDiff = Math.sqrt(variance);
  const se = sdDiff / Math.sqrt(n);
  const verdict = verdictFrom(meanDiff, se, informativeNullThreshold);

  return {
    n,
    meanDiff,
    sdDiff,
    se,
    ci95: verdict.ci95,
    mde80: verdict.mde80,
    nullIsInformative: verdict.nullIsInformative,
  };
}

/**
 * How many PAIRS are needed to detect `delta` at alpha=0.05 two-sided, 80% power,
 * given an expected per-pair SD.
 *
 * Use it to SIZE a run before spending on it — the step D-093's run skipped, and
 * the reason its sample could not have answered its own question.
 */
export function requiredPairs(sdDiff: number, delta: number): number | null {
  if (!(sdDiff > 0) || !(Math.abs(delta) > 0)) return null;
  return Math.ceil(((Z_95 + Z_POWER_80) * sdDiff / Math.abs(delta)) ** 2);
}

export interface Stratum {
  name: RerankOpportunity;
  /** Share of the POPULATION this stratum represents (base rate, sums to ~1). */
  share: number;
  /** Effect measured WITHIN this stratum (mean difference). */
  effect: number;
  /** Standard error of `effect` within this stratum. */
  se: number;
}

export interface PopulationEffect {
  /** Share-weighted population mean difference. */
  effect: number;
  se: number;
  ci95: readonly [number, number];
  /**
   * Same discipline as {@link PairedDifference.mde80}, applied to the number the
   * integration decision actually uses. Without it the population line was the
   * ONE result in this report that could be read as "no effect" with no way to
   * tell an informative null from an underpowered one — the D-093 shape, on the
   * headline figure.
   */
  mde80: number;
  /** Three-valued, exactly as on a per-stratum difference: true | false | null. */
  nullIsInformative: boolean | null;
  /** Strata whose share was supplied but which contributed no measured effect. */
  unmeasured: readonly RerankOpportunity[];
}

/**
 * The shared verdict arithmetic, so a per-stratum difference and the population
 * effect cannot drift apart on how they read a zero.
 */
function verdictFrom(
  effect: number,
  se: number,
  informativeNullThreshold: number,
): { ci95: readonly [number, number]; mde80: number; nullIsInformative: boolean | null } {
  const half = Z_95 * se;
  const mde80 = (Z_95 + Z_POWER_80) * se;
  const ciContainsZero = effect - half <= 0 && effect + half >= 0;
  return {
    ci95: [effect - half, effect + half] as const,
    mde80,
    nullIsInformative: !ciContainsZero ? false : mde80 <= informativeNullThreshold ? true : null,
  };
}

/**
 * Reweight per-stratum effects back to the POPULATION.
 *
 * Needed because the run deliberately OVERSAMPLES `order-blocked` — the only
 * stratum where the treatment can act. Oversampling buys power; without this
 * reweighting it would also silently overstate the production effect by the
 * oversampling factor, which is a worse error than the one it fixes.
 *
 * `admitted` and `not-retrieved` are not assumed to contribute 0 — they are
 * measured too (rerank can DEMOTE an already-admitted row, a real cost that an
 * order-blocked-only run would never see). A stratum with no measured effect is
 * reported in `unmeasured` rather than being quietly treated as a zero.
 */
export function reweightToPopulation(
  strata: readonly Stratum[],
  informativeNullThreshold = 0.02,
): PopulationEffect | null {
  if (strata.length === 0) return null;
  const totalShare = strata.reduce((a, s) => a + s.share, 0);
  if (!(totalShare > 0)) return null;

  let effect = 0;
  let varSum = 0;
  const unmeasured: RerankOpportunity[] = [];
  for (const s of strata) {
    const w = s.share / totalShare;
    if (!Number.isFinite(s.effect)) {
      unmeasured.push(s.name);
      continue;
    }
    effect += w * s.effect;
    varSum += (w * s.se) ** 2;
  }
  const se = Math.sqrt(varSum);
  const verdict = verdictFrom(effect, se, informativeNullThreshold);
  return {
    effect,
    se,
    ci95: verdict.ci95,
    mde80: verdict.mde80,
    nullIsInformative: verdict.nullIsInformative,
    unmeasured,
  };
}

/**
 * The MOST a stratum could ever contribute to the population metric, given how
 * rarely it was observed.
 *
 * This is the answer to the question a rare-stratum run cannot otherwise reach.
 * When `order-blocked` — the only band reranking can win — comes back empty, the
 * naive reading is "underpowered, measure more". But an ABSENCE bounds the share
 * (Wilson upper bound; at 0 observed it agrees with the rule of three, ~3/n), and
 * the share bounds the population effect: nDCG ∈ [0,1], so a target sitting below
 * the cut contributes 0 and can gain at most 1.0 by being lifted to rank 1.
 *
 * So `populationCeiling` is what a PERFECT reranker — one that rescues every
 * order-blocked query flawlessly — could add. If that ceiling is below the
 * smallest effect worth shipping, the integration question is CLOSED, and no
 * larger sample can reopen it. That is a conclusion from absence, not a
 * confession of insufficient data.
 */
export function rescueCeiling(input: {
  /** Pairs observed in the stratum. */
  observed: number;
  /** Queries classified into strata (the denominator of the share). */
  n: number;
  /** Largest per-pair gain the metric admits. nDCG ⇒ 1. */
  maxPerPairGain?: number;
}): { shareUpperBound: number; populationCeiling: number } | null {
  const { observed, n } = input;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!Number.isFinite(observed) || observed < 0 || observed > n) return null;
  const maxGain = input.maxPerPairGain ?? 1;
  if (!Number.isFinite(maxGain) || maxGain <= 0) return null;

  // Wilson upper bound: well-behaved at observed = 0, where a normal
  // approximation would collapse to exactly 0 and imply a FALSE certainty.
  const z = 1.96;
  const p = observed / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const shareUpperBound = Math.min(1, centre + half);
  return { shareUpperBound, populationCeiling: shareUpperBound * maxGain };
}

export interface InstrumentValidity {
  ok: boolean;
  reasons: readonly string[];
  /** Non-void caveats that MUST be printed beside the verdict, never dropped. */
  warnings: readonly string[];
  /** Pairs the stage did not rerank — EXCLUDED from every delta, never mixed in. */
  excludedNonEngaged: number;
  /**
   * attempted / RERANKABLE (not / total): a query the engine was never asked to
   * handle is not evidence about the engine. Null when nothing was rerankable.
   */
  engagementRate: number | null;
  /** Queries structurally un-rerankable (pool ≤ 1). Benign — not engine health. */
  benignSkips: number;
  /** Queries the engine SHOULD have handled and did not (no-engine / threw). */
  engineFailures: number;
}

/**
 * Minimum share of queries on which the rerank stage must have ENGAGED for the
 * run to be analysable at all.
 *
 * Above the floor, non-engaged pairs are EXCLUDED from the delta (they are
 * treatment == control by construction, so mixing them in only dilutes the
 * estimate toward zero). Below it, the engine was substantially unavailable and
 * no subset of the run can be attributed to the reranker.
 */
export const MIN_ENGAGEMENT_RATE = 0.9;

/**
 * Would this run be publishable, or must it be VOIDED?
 *
 * `rerankRows` is fail-soft BY CONTRACT: with no engine it returns the input
 * order, byte-identical to the control arm. So a treatment that silently lost
 * its engine produces a clean 0.000 delta that reads exactly like "reranking
 * does not help" — and the natural response to that null is to abandon the
 * feature. The numbers alone cannot distinguish the two.
 *
 * D-093 already applied this discipline and it is kept deliberately. Added
 * here: `engine`, because `rerank.ts` resolves ZeroEntropy FIRST (:161/:238) and
 * the local cross-encoder only as a FALLBACK (:185) — so a benchmark that does
 * not RECORD which engine ran may be describing a different reranker from the
 * one deployed (WI-37649).
 */
export function instrumentValidity(input: {
  attempted: number;
  total: number;
  ordersMoved: number;
  engine: string | null;
  /**
   * Of the non-engaged queries, how many were `nothing-to-reorder` (pool ≤ 1).
   * These are structurally un-rerankable, NOT engine failures, so they leave the
   * engine-health denominator. Everything else non-engaged (`no-engine`,
   * `threw:*`) IS an engine failure and counts against the floor.
   */
  benignSkips?: number;
}): InstrumentValidity {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const { attempted, total } = input;
  const excludedNonEngaged = Math.max(0, total - attempted);
  // `nothing-to-reorder` (pool ≤ 1) is NOT an engine failure: the engine was
  // never asked. Counting it against engine health would let a genuinely dark
  // engine hide behind a pile of un-rerankable queries — the D-093 failure with
  // extra steps. So it leaves the denominator entirely.
  const benignSkips = Math.min(Math.max(0, input.benignSkips ?? 0), excludedNonEngaged);
  const rerankable = Math.max(0, total - benignSkips);
  const engineFailures = Math.max(0, rerankable - attempted);
  const engagementRate = rerankable > 0 ? attempted / rerankable : null;

  if (total <= 0) reasons.push('no queries ran');
  else if (rerankable <= 0)
    reasons.push(
      `every one of the ${total} queries was structurally un-rerankable (pool ≤ 1) — the engine was never exercised, so this run says nothing about reranking`,
    );
  if (benignSkips > 0)
    warnings.push(
      `${benignSkips}/${total} queries had a pool of ≤1 row and are structurally un-rerankable — excluded from the delta, and NOT counted as engine failures (the engine was never asked)`,
    );
  if (attempted <= 0 && rerankable > 0)
    reasons.push('the rerank stage NEVER engaged — this is a dead-engine run, not a null result');
  else if (attempted > 0 && engineFailures > 0) {
    // PARTIAL engagement is NOT a dead engine, and voiding the whole run for it
    // is a power failure of its own: one fail-soft query discarded 389 good
    // pairs on the 2026-08-10 pool=24 run. A fail-soft pair is treatment ==
    // control BY CONSTRUCTION, so the fix is to EXCLUDE it from the delta (see
    // the CLI's `engaged` filter), not to mix it in and not to bin the run.
    // The floor keeps D-093's protection: a substantially dead engine still voids.
    if (engagementRate !== null && engagementRate < MIN_ENGAGEMENT_RATE) {
      reasons.push(
        `the engine failed on ${engineFailures}/${rerankable} RERANKABLE queries — engagement ` +
          `${(engagementRate * 100).toFixed(1)}%, below the ${(MIN_ENGAGEMENT_RATE * 100).toFixed(0)}% floor — ` +
          `too little engagement to attribute any delta to the reranker`,
      );
    } else {
      warnings.push(
        `${engineFailures}/${rerankable} rerankable queries were fail-soft ENGINE FAILURES ` +
          `(no-engine / threw) and are EXCLUDED from every delta below — they are ` +
          `treatment == control by construction, so including them would dilute the estimate toward zero`,
      );
      warnings.push(
        `engine engagement was ${(engagementRate! * 100).toFixed(1)}% — the excluded pairs are NOT a ` +
          `random sample if the engine drops on the largest/slowest queries, so the estimand is ` +
          `"the effect WHEN the reranker runs", not "the effect of enabling it"`,
      );
    }
  }
  if (input.ordersMoved <= 0)
    reasons.push('the admitted ORDER never moved on any query — indistinguishable from a disabled reranker');
  if (!input.engine) reasons.push('no rerank engine was recorded — the result cannot be attributed to a specific reranker (WI-37649)');
  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
    excludedNonEngaged,
    engagementRate,
    benignSkips,
    engineFailures,
  };
}
