/**
 * model.ts — the learned deferral-pricing model (self-learning-frontier P-042 /
 * FB-14). PURE fit/predict/explain over backfill outcomes; no PG, no IO.
 *
 * v0 is a multiplicative shrunken-rate model — deliberately the simplest thing
 * that is LEARNED, INSPECTABLE, and honest at tiny n (the alpha corpus has a
 * few hundred improvements; weeks of decided outcomes don't exist yet):
 *
 *   price(item) = globalRatePerWeek × ∏ factor(bucket)   over the item's buckets
 *
 *   - globalRatePerWeek — pooled realized cost per deferral-week across the
 *     whole training set (Σ cost / Σ weeks: exposure-weighted, so a 2-hour
 *     window can't explode a per-item rate).
 *   - factor(bucket)    — the bucket's pooled rate relative to global, SHRUNK
 *     toward 1.0 by exposure: factor = (weeks_b·raw + PRIOR_WEEKS·1) /
 *     (weeks_b + PRIOR_WEEKS). A bucket with little exposure prices like the
 *     global average; only sustained evidence moves a coefficient.
 *
 * Every coefficient is a NAMED bucket ('severity:critical', 'watchdog:yes', …)
 * with its sample sizes attached — the D-005 inspectable-weights contract. The
 * unit matches blocking-impact ("one minor thing waiting" per week of
 * continued deferral), so the ranker reads both features on one scale.
 *
 * WEAK-DATA HONESTY (the brief's required note): a model trained on fewer than
 * WEAK_SAMPLE_ITEMS deferrals or WEAK_SAMPLE_WEEKS exposure-weeks flags itself
 * `weak`, and every price it produces carries the caveat in its reasons. The
 * coefficients only firm up as weeks of decided outcomes accumulate.
 */

import type { DeferralFeatures, DeferralOutcome } from './outcomes';
import { featureBuckets } from './outcomes';

/** Shrinkage prior strength, in exposure-weeks ("pretend every bucket starts
 *  with this many weeks of exactly-average evidence"). */
export const PRIOR_WEEKS = 8;
/** Factors clamp here — tiny corpora must not mint 100× coefficients. */
export const FACTOR_CLAMP: readonly [number, number] = [0.1, 10];
export const WEAK_SAMPLE_ITEMS = 50;
export const WEAK_SAMPLE_WEEKS = 100;

export interface BucketCoefficient {
  /** Multiplicative factor vs the global rate (shrunken, clamped). */
  factor: number;
  /** Unshrunk pooled rate inside the bucket (cost per week). */
  rawRatePerWeek: number;
  items: number;
  weeks: number;
}

export interface DeferralPricingModel {
  version: 1;
  trainedAt: string;
  /** Pooled realized cost per deferral-week across the training set. */
  globalRatePerWeek: number;
  totalItems: number;
  totalWeeks: number;
  priorWeeks: number;
  buckets: Record<string, BucketCoefficient>;
  /** Self-declared weak-coefficients flag (v0 honesty). */
  weak: boolean;
}

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

export interface FitOptions {
  /** ISO timestamp recorded on the model (callers pass their clock). */
  trainedAt: string;
  priorWeeks?: number;
}

/** Fit the v0 pricing model from backfill outcomes. Pure + deterministic. */
export function fitDeferralPricingModel(
  outcomes: readonly DeferralOutcome[],
  opts: FitOptions,
): DeferralPricingModel {
  const priorWeeks = opts.priorWeeks ?? PRIOR_WEEKS;
  const totalWeeks = outcomes.reduce((s, o) => s + o.weeksDeferred, 0);
  const totalCost = outcomes.reduce((s, o) => s + o.realizedCost, 0);
  const globalRatePerWeek = totalWeeks > 0 ? totalCost / totalWeeks : 0;

  const agg = new Map<string, { cost: number; weeks: number; items: number }>();
  for (const o of outcomes) {
    for (const bucket of featureBuckets(o.features)) {
      const a = agg.get(bucket) ?? { cost: 0, weeks: 0, items: 0 };
      a.cost += o.realizedCost;
      a.weeks += o.weeksDeferred;
      a.items += 1;
      agg.set(bucket, a);
    }
  }

  const buckets: Record<string, BucketCoefficient> = {};
  for (const [bucket, a] of [...agg.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    const rawRatePerWeek = a.weeks > 0 ? a.cost / a.weeks : 0;
    // raw/global is the unshrunk factor; with no global signal everything is 1.
    const rawFactor = globalRatePerWeek > 0 ? rawRatePerWeek / globalRatePerWeek : 1;
    const shrunk = (a.weeks * rawFactor + priorWeeks * 1) / (a.weeks + priorWeeks);
    buckets[bucket] = {
      factor: round(Math.min(Math.max(shrunk, FACTOR_CLAMP[0]), FACTOR_CLAMP[1]), 3),
      rawRatePerWeek: round(rawRatePerWeek, 3),
      items: a.items,
      weeks: round(a.weeks, 2),
    };
  }

  return {
    version: 1,
    trainedAt: opts.trainedAt,
    globalRatePerWeek: round(globalRatePerWeek, 3),
    totalItems: outcomes.length,
    totalWeeks: round(totalWeeks, 2),
    priorWeeks,
    buckets,
    weak: outcomes.length < WEAK_SAMPLE_ITEMS || totalWeeks < WEAK_SAMPLE_WEEKS,
  };
}

export interface PricedDeferral {
  /** Expected realized cost per week of CONTINUED deferral (B-08's unit). */
  ratePerWeek: number;
  /** The named factors applied (only the ones that moved off 1.0). */
  factors: { bucket: string; factor: number; items: number }[];
  weak: boolean;
  /** Human-readable "why this price" lines (D-005 inspectability). */
  reasons: string[];
}

/** Price one new deferral from its creation-time features. Pure; never throws. */
export function priceDeferral(model: DeferralPricingModel, features: DeferralFeatures): PricedDeferral {
  let rate = model.globalRatePerWeek;
  const factors: PricedDeferral['factors'] = [];
  for (const bucket of featureBuckets(features)) {
    const coeff = model.buckets[bucket];
    if (!coeff) continue; // unseen bucket prices like the global average
    rate *= coeff.factor;
    if (coeff.factor !== 1) factors.push({ bucket, factor: coeff.factor, items: coeff.items });
  }
  const ratePerWeek = round(rate, 3);

  const reasons: string[] = [
    `expected ~${ratePerWeek} blocked-work unit(s) accruing per week deferred (global base ${model.globalRatePerWeek}/wk)`,
  ];
  const moved = [...factors].sort((a, b) => Math.abs(Math.log(b.factor)) - Math.abs(Math.log(a.factor)));
  for (const f of moved.slice(0, 3)) {
    reasons.push(`${f.bucket} ×${f.factor} (n=${f.items})`);
  }
  if (model.weak) {
    reasons.push(
      `weak coefficients — trained on ${model.totalItems} deferral(s) / ${model.totalWeeks} exposure-week(s); firms up as outcomes accumulate`,
    );
  }
  return { ratePerWeek, factors, weak: model.weak, reasons };
}

/** Structural guard for a model deserialized from the PG jsonb column. */
export function isDeferralPricingModel(v: unknown): v is DeferralPricingModel {
  if (!v || typeof v !== 'object') return false;
  const m = v as Partial<DeferralPricingModel>;
  return (
    m.version === 1 &&
    typeof m.trainedAt === 'string' &&
    typeof m.globalRatePerWeek === 'number' &&
    typeof m.totalItems === 'number' &&
    typeof m.totalWeeks === 'number' &&
    typeof m.weak === 'boolean' &&
    !!m.buckets &&
    typeof m.buckets === 'object'
  );
}
