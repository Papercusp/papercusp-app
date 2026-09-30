/**
 * Deferral interest as a feature of the one ranker (self-learning-frontier
 * P-042 / FB-14, landing in P-040's registry per D-005/D-006). The LEARNED
 * successor of blocking-impact's static prior: prices each human-lane item by
 * the expected realized cost per week of CONTINUED deferral, from the latest
 * backfill-trained pricing model (lib/deferral-interest/).
 *
 * Same unit as blocking-impact ("one minor thing waiting"), so the weighted
 * sum reads coherently: blocking-impact carries what has ALREADY accrued ×
 * staleness; this feature carries the learned accrual RATE going forward.
 *
 * Inert-until-armed (frontier D-001): contributes 0 for every item while the
 * `papercusp-deferral-interest` flag is OFF (kill-switch, fail-dark on flag
 * IO errors) or while no model is trained (the refit loop only runs once
 * armed at P-001) — so registering the feature is behavior-identical to the
 * pre-FB-14 ordering until the owner arms the lane.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { ScoredItem } from '../harness/improvements/digest';
import type { DeferralFeatures } from '../deferral-interest/outcomes';
import { priceDeferral, type DeferralPricingModel } from '../deferral-interest/model';
import { loadLatestDeferralModel } from '../deferral-interest/store';
import type { FeatureValue, QueueFeature } from './ranker';
import type { HumanQueueRankContext } from './blocking-impact-feature';

/** Injectable IO (unit tests inject fakes; production reads PG + flags). */
export interface DeferralInterestFeatureDeps {
  /** Latest trained model, or null (pre-refit / read failure → inert). */
  loadModel: () => Promise<DeferralPricingModel | null>;
  /** The D-001 kill-switch — papercusp-deferral-interest. */
  isEnabled: () => Promise<boolean>;
}

export const defaultDeferralInterestFeatureDeps: DeferralInterestFeatureDeps = {
  loadModel: async () => {
    const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../workspace-registry'),
    ]);
    return loadLatestDeferralModel(getOrgPg().sql, activeWorkspaceId());
  },
  isEnabled: async () => {
    try {
      return await getFlag(FLAGS.DEFERRAL_INTEREST, 'queue-ranker');
    } catch {
      return false; // fail-DARK: a flag-IO hiccup must not arm the feature
    }
  },
};

/** Creation-time features from the queue item (+ watchdogKey off the raw candidate). */
function scoredItemFeatures(item: ScoredItem, ctx: HumanQueueRankContext): DeferralFeatures {
  const candidate = ctx.candidates?.find((c) => c.id === item.id);
  return {
    severity: item.severity ?? 'minor',
    kind: item.kind,
    watchdog: Boolean(candidate?.watchdogKey),
    source: item.source ?? 'human',
    scopeKind: item.scope.startsWith('harness:') ? 'harness' : 'operator',
  };
}

/** Factory so tests inject deps; the registry uses the default instance below. */
export function makeDeferralInterestFeature(
  deps: DeferralInterestFeatureDeps = defaultDeferralInterestFeatureDeps,
): QueueFeature<ScoredItem, HumanQueueRankContext> {
  return {
    name: 'deferral-interest',
    weight: 1,
    description:
      'Learned price of continued deferral: expected blocked-work units accruing per week, from the backfill-trained pricing model (P-042; inert until armed + trained).',
    async score(items, ctx) {
      const out = new Map<string, FeatureValue>();
      if (items.length === 0 || !(await deps.isEnabled())) return out;
      let model: DeferralPricingModel | null = null;
      try {
        model = await deps.loadModel();
      } catch (err) {
        console.warn(
          '[queue-ranker] deferral-interest model read failed — contributing 0:',
          err instanceof Error ? err.message : err,
        );
      }
      if (!model) return out;
      for (const item of items) {
        const priced = priceDeferral(model, scoredItemFeatures(item, ctx));
        out.set(item.id, {
          value: priced.ratePerWeek,
          reasons: priced.reasons,
          attach: { deferral: { ratePerWeek: priced.ratePerWeek, weak: priced.weak } },
        });
      }
      return out;
    },
  };
}

export const deferralInterestFeature: QueueFeature<ScoredItem, HumanQueueRankContext> =
  makeDeferralInterestFeature();
