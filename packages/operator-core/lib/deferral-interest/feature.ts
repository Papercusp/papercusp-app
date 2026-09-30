/**
 * feature.ts — deferral interest as a queue-ranker FEATURE (self-learning-
 * frontier P-042 / FB-14, the D-005 contract: economic signals are features of
 * the ONE ranker, never independent rankers).
 *
 * Prices a human-queue item from the latest trained DeferralPricingModel:
 * the feature value is the expected realized cost per week of CONTINUED
 * deferral, in blocking-impact's unit ("one minor thing waiting") — so the
 * ranker can read this learned feature and B-08's static score on one scale.
 *
 * RANKER WIRING NOTE (FB-12 / P-040): the named-feature registry ships with
 * the one-ranker scaffold, which had not landed when this module did. This
 * file is the registry-READY seam — `DEFERRAL_INTEREST_FEATURE_KEY`, a
 * per-item evaluator, and an async loader that degrades to a zero-priced
 * no-model evaluator (the ranker must never 500 because the refit hasn't
 * run — blocking-impact's defensive-degradation principle). The final
 * one-line registration into lib/queue-ranker's registry lands when
 * `frontier:ranker-landed` fires (this lane holds an events:await on it).
 */

import type { Sql } from 'postgres';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { deferralFeaturesOf } from './outcomes';
import { priceDeferral, type DeferralPricingModel } from './model';
import { loadLatestDeferralModel } from './store';

export const DEFERRAL_INTEREST_FEATURE_KEY = 'deferral-interest';

/** One item's feature reading — value + the D-005 "why" lines. */
export interface DeferralFeatureValue {
  /** Expected blocked-work units accruing per week of continued deferral.
   *  0 when no model is trained yet (the pre-refit degradation). */
  value: number;
  reasons: string[];
}

export type DeferralFeatureEvaluator = (item: ImprovementCandidate) => DeferralFeatureValue;

const NO_MODEL: DeferralFeatureValue = {
  value: 0,
  reasons: ['no trained deferral-pricing model yet — the deferral-interest refit has not run (frontier P-001 arming)'],
};

/** Build the per-item evaluator over a trained model (null ⇒ zero-priced degradation). */
export function deferralFeatureEvaluator(model: DeferralPricingModel | null): DeferralFeatureEvaluator {
  if (!model) return () => NO_MODEL;
  return (item) => {
    const priced = priceDeferral(model, deferralFeaturesOf(item));
    return { value: priced.ratePerWeek, reasons: priced.reasons };
  };
}

/** Load the latest model and return the evaluator — defensively (a store
 *  read failure degrades to the no-model evaluator, never throws upward). */
export async function loadDeferralFeature(sql: Sql, workspaceId: string): Promise<DeferralFeatureEvaluator> {
  try {
    return deferralFeatureEvaluator(await loadLatestDeferralModel(sql, workspaceId));
  } catch (err) {
    console.warn(
      '[deferral-interest] model read failed — pricing degrades to no-model:',
      err instanceof Error ? err.message : err,
    );
    return deferralFeatureEvaluator(null);
  }
}
