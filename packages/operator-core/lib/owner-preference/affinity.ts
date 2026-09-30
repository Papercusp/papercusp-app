/**
 * owner-preference affinity model (self-learning-frontier-2026-06-12 P-043 /
 * FB-15) — the PURE leg: turn observed owner interactions into a bounded
 * re-ranking value per human-queue item.
 *
 * The model is attention prediction, nothing more: from what the owner has
 * engaged with (grades/regrades on routed ideas, joined back to their EI
 * attributes) versus what the owner was merely SHOWN (queue-view exposure
 * events), learn per-attribute-bucket engagement lift, then score each queue
 * item by its buckets — minus a mild penalty for items the owner has been
 * shown many times and never touched ("ignored despite exposure").
 *
 * Hard rules carried from the plan (D-005 + the P-043 item text):
 *  - RE-RANKING ONLY. The output is a bounded value in [-1, 1] consumed as a
 *    weighted feature by the one ranker — it never gates, blocks, or decides.
 *  - EXPLICIT GRADES SOVEREIGN. This module never writes or reinterprets a
 *    grade; grade VALUE is deliberately ignored (a 1-grade and a 5-grade are
 *    the same *attention* signal — judging quality is the grading system's
 *    job, not this model's).
 *  - HONEST COLD START. Below the minimum-evidence floors everything scores
 *    0 — the feature is a no-op until real interaction history accumulates
 *    (the plan's "data-starved early" expectation, made explicit).
 *
 * Pure and deterministic: no IO, no clock — exposure counts and ageDays
 * arrive pre-computed from the IO leg (interactions.ts).
 */

import type { FeatureValue } from '../queue-ranker/ranker';

/** The item attributes the model buckets on (a structural slice of ScoredItem). */
export interface PreferenceItem {
  id: string;
  severity?: string;
  scope: string;
  ageDays: number;
}

/** One owner engagement, joined to the engaged item's attributes where known. */
export interface OwnerEngagement {
  kind: 'grade' | 'regrade';
  /** The EI id the engagement resolved to (`wi:` ref stripped), when it did. */
  itemId?: string;
  /** Joined engineer_issues attributes — absent for non-EI rails (gym:, plan:). */
  severity?: string;
  scope?: string;
}

/** The owner signal the IO leg assembles for the feature. */
export interface OwnerSignal {
  engagements: readonly OwnerEngagement[];
  /** Per-item exposure counts: how many queue-view events included each id. */
  exposureCountById: ReadonlyMap<string, number>;
  /** Bucket exposure counts keyed `dim:value` (see bucketKeysFor). */
  exposureCountByBucket: ReadonlyMap<string, number>;
  /** Total (event × item) exposure pairs — the lift denominator. */
  totalExposures: number;
}

export interface OwnerPreferenceOpts {
  /** Below this many total owner engagements the model emits all-zero. */
  minTotalEngagements?: number;
  /** A bucket with fewer exposures than this contributes no affinity. */
  minBucketExposures?: number;
  /** Ignore penalty arms only at/after this many exposures of one item… */
  ignoreMinExposures?: number;
  /** …and only once the item is at least this old (days). */
  ignoreMinAgeDays?: number;
}

const DEFAULTS: Required<OwnerPreferenceOpts> = {
  minTotalEngagements: 5,
  minBucketExposures: 3,
  ignoreMinExposures: 5,
  ignoreMinAgeDays: 3,
};

/** 'operator' stays; every 'harness:<slug>' collapses to one class. */
function scopeClass(scope: string): string {
  return scope === 'operator' ? 'operator' : 'harness';
}

/** The bucket keys one item (or one joined engagement) falls into. */
export function bucketKeysFor(attrs: { severity?: string; scope?: string }): string[] {
  const keys: string[] = [];
  if (attrs.severity) keys.push(`severity:${attrs.severity}`);
  if (attrs.scope) keys.push(`scope:${scopeClass(attrs.scope)}`);
  return keys;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp1 = (n: number) => Math.max(-1, Math.min(1, n));

/**
 * Per-bucket affinity: log2 of the Laplace-smoothed engagement-rate lift over
 * the base rate, squashed to [-1, 1] (lift 4× → +1, lift ¼× → −1).
 */
function bucketAffinity(
  eng: number,
  exp: number,
  engTotal: number,
  expTotal: number,
): number {
  const rate = (eng + 1) / (exp + 2);
  const base = (engTotal + 1) / (expTotal + 2);
  return clamp1(Math.log2(rate / base) / 2);
}

/**
 * Score every item: mean of its buckets' affinities minus the ignored-despite-
 * exposure penalty, clamped to [-1, 1], each component carried as a reason
 * line (the ranker's explain surface shows these verbatim).
 */
export function computeOwnerPreference(
  items: readonly PreferenceItem[],
  signal: OwnerSignal,
  opts: OwnerPreferenceOpts = {},
): Map<string, FeatureValue> {
  const o = { ...DEFAULTS, ...opts };
  const out = new Map<string, FeatureValue>();
  if (items.length === 0) return out;

  // Cold start: not enough owner history to say anything — all zero.
  if (signal.engagements.length < o.minTotalEngagements) return out;

  // Engagement counts per bucket + the set of directly-engaged item ids.
  const engByBucket = new Map<string, number>();
  const engagedIds = new Set<string>();
  for (const e of signal.engagements) {
    if (e.itemId) engagedIds.add(e.itemId);
    for (const key of bucketKeysFor(e)) {
      engByBucket.set(key, (engByBucket.get(key) ?? 0) + 1);
    }
  }

  for (const item of items) {
    const reasons: string[] = [];
    const affs: number[] = [];
    for (const key of bucketKeysFor(item)) {
      const exp = signal.exposureCountByBucket.get(key) ?? 0;
      if (exp < o.minBucketExposures) continue;
      const eng = engByBucket.get(key) ?? 0;
      const aff = bucketAffinity(eng, exp, signal.engagements.length, signal.totalExposures);
      if (aff === 0) continue;
      affs.push(aff);
      reasons.push(
        `owner ${aff > 0 ? 'engages' : 'rarely engages'} ${key.replace(':', ' ')} items ` +
          `(${eng} engagement(s) / ${exp} shown)`,
      );
    }
    let value = affs.length > 0 ? affs.reduce((a, b) => a + b, 0) / affs.length : 0;

    const exposures = signal.exposureCountById.get(item.id) ?? 0;
    if (
      exposures >= o.ignoreMinExposures &&
      item.ageDays >= o.ignoreMinAgeDays &&
      !engagedIds.has(item.id)
    ) {
      const penalty = Math.min(0.5, 0.1 * Math.log2(exposures));
      value -= penalty;
      reasons.push(`shown ${exposures}× with no owner interaction (−${round3(penalty)})`);
    }

    value = round3(clamp1(value));
    if (value !== 0) out.set(item.id, { value, reasons });
  }
  return out;
}
