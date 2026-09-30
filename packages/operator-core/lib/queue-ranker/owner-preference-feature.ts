/**
 * Owner preference as a feature of the one ranker (self-learning-frontier
 * P-043 / FB-15, landing in P-040's registry per D-005). Models the owner's
 * ATTENTION from implicit interaction telemetry — what the owner grades,
 * what the owner is shown and never touches — and nudges the human queue
 * toward what this owner actually engages with (lib/owner-preference/).
 *
 * Hard rules (P-043 item text): RE-RANKING ONLY — a bounded [-1, 1] value ×
 * this weight, never a gate or a decision; EXPLICIT GRADES SOVEREIGN — the
 * model never writes or reinterprets a grade (grade value is deliberately
 * ignored; attention is the signal, quality judgment stays with grading).
 * Every contribution carries its reason lines, so "why did this rank here?"
 * is answerable from rank.features verbatim.
 *
 * Inert-until-armed (frontier D-001): contributes 0 for every item while
 * `papercusp-owner-preference-ranking` is OFF (kill-switch, fail-dark on
 * flag-IO errors) — and honestly near-0 even when armed until interaction
 * history accumulates past the model's minimum-evidence floors (capture is
 * always-on substrate; see lib/owner-preference/interactions.ts).
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { ScoredItem } from '../harness/improvements/digest';
import { computeOwnerPreference, type OwnerSignal } from '../owner-preference/affinity';
import type { QueueFeature } from './ranker';
import type { HumanQueueRankContext } from './blocking-impact-feature';

/** Injectable IO (unit tests inject fakes; production reads PG + flags). */
export interface OwnerPreferenceFeatureDeps {
  /** The assembled owner signal (engagements + exposure counts). */
  readSignal: () => Promise<OwnerSignal>;
  /** The D-001 kill-switch — papercusp-owner-preference-ranking. */
  isEnabled: () => Promise<boolean>;
}

export const defaultOwnerPreferenceFeatureDeps: OwnerPreferenceFeatureDeps = {
  readSignal: async () => {
    const { readOwnerSignal } = await import('../owner-preference/interactions');
    return readOwnerSignal();
  },
  isEnabled: async () => {
    try {
      return await getFlag(FLAGS.OWNER_PREFERENCE_RANKING, 'queue-ranker');
    } catch {
      return false; // fail-DARK: a flag-IO hiccup must not arm the feature
    }
  },
};

/** Factory so tests inject deps; the registry uses the default instance below. */
export function makeOwnerPreferenceFeature(
  deps: OwnerPreferenceFeatureDeps = defaultOwnerPreferenceFeatureDeps,
): QueueFeature<ScoredItem, HumanQueueRankContext> {
  return {
    name: 'owner-preference',
    weight: 2,
    description:
      'Implicit owner-attention model: engagement lift per attribute bucket vs what the owner was shown, minus an ignored-despite-exposure penalty; bounded [-1, 1] re-ranking nudge (P-043; inert until armed, near-0 until history accumulates).',
    async score(items, ctx) {
      if (items.length === 0 || !(await deps.isEnabled())) return new Map();
      let signal: OwnerSignal | null = null;
      try {
        signal = await deps.readSignal();
      } catch (err) {
        console.warn(
          '[queue-ranker] owner-preference signal read failed — contributing 0:',
          err instanceof Error ? err.message : err,
        );
      }
      if (!signal) return new Map();
      // ctx is the human-queue context; items carry id/severity/scope/ageDays,
      // which is the full PreferenceItem surface the pure model buckets on.
      void ctx;
      return computeOwnerPreference(items, signal);
    },
  };
}

export const ownerPreferenceFeature: QueueFeature<ScoredItem, HumanQueueRankContext> =
  makeOwnerPreferenceFeature();
