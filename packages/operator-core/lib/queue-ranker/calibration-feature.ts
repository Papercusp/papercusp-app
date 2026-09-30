/**
 * Calibration as a feature of the one ranker (self-learning-frontier P-041 /
 * FB-13, landing in P-040's registry per D-005). Prices each human-lane item
 * by what the recorded bets (lib/calibration/) imply about it:
 *
 *   - a FAILED fix-survival bet on the item ("this fix bounced before") is the
 *     strongest single signal — a bouncer deserves the human's eyes sooner;
 *   - an OPEN bet contributes its bad-outcome expectation × the bettor's
 *     Brier-earned trust weight — a sharp predictor betting against an item
 *     moves it up; an unknown or noisy one barely does.
 *
 * Same direction as blocking-impact ("attend sooner"); the scale is anchored
 * so one bounced fix ≈ one outbound `blocks` edge (see BOUNCED_FIX_VALUE).
 *
 * Inert-until-armed (frontier D-001): contributes 0 for every item while the
 * `papercusp-calibration-markets` flag is OFF (kill-switch, fail-dark on flag
 * IO errors) — and the same flag gates the capture seams, so there are no
 * bets to read while dark. Registering the feature is behavior-identical to
 * the pre-FB-13 ordering until the owner arms the lane at P-001.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { ScoredItem } from '../harness/improvements/digest';
import { badOutcomeExpectation, NEUTRAL_WEIGHT } from '../calibration/scoring';
import type { CalibrationScore, PredictionRow } from '../calibration/types';
import type { FeatureValue, QueueFeature } from './ranker';
import type { HumanQueueRankContext } from './blocking-impact-feature';

/** What one IO pass loads for the whole queue. */
export interface CalibrationQueueSignals {
  openBets: readonly PredictionRow[];
  /** Per-subject count of FAILED fix-survival bets. */
  bouncedBySubject: ReadonlyMap<string, number>;
  /** Per-persona per-domain Brier scores (weights attached). */
  scores: readonly CalibrationScore[];
}

/** Injectable IO (unit tests inject fakes; production reads PG + flags). */
export interface CalibrationFeatureDeps {
  /** The D-001 kill-switch — papercusp-calibration-markets. */
  isEnabled: () => Promise<boolean>;
  loadSignals: (subjectIds: readonly string[]) => Promise<CalibrationQueueSignals>;
}

export const defaultCalibrationFeatureDeps: CalibrationFeatureDeps = {
  isEnabled: async () => {
    try {
      return await getFlag(FLAGS.CALIBRATION_MARKETS, 'queue-ranker');
    } catch {
      return false; // fail-DARK: a flag-IO hiccup must not arm the feature
    }
  },
  loadSignals: async (subjectIds) => {
    const [{ getOrgPg }, { activeWorkspaceId }, store] = await Promise.all([
      import('@papercusp/db-org'),
      import('../workspace-registry'),
      import('../calibration/store'),
    ]);
    const sql = getOrgPg().sql;
    const workspaceId = activeWorkspaceId();
    const [openBets, bouncedBySubject, scores] = await Promise.all([
      store.openBetsForSubjects(sql, { workspaceId, subjectIds }),
      store.bouncedFixCounts(sql, { workspaceId, subjectIds }),
      store.calibrationScores(sql, { workspaceId }),
    ]);
    return { openBets, bouncedBySubject, scores };
  },
};

/**
 * Value of one failed fix-survival bet, in the registry's shared unit —
 * anchored to blocking-impact's outbound-`blocks`-edge weight (12) via the
 * feature weight below: 2 × 8 = 16 ≈ "a bit worse than one blocked item".
 */
export const BOUNCED_FIX_VALUE = 2;

const weightKey = (predictor: string, domain: string): string => `${predictor}\x00${domain}`;

/** Factory so tests inject deps; the registry uses the default instance below. */
export function makeCalibrationFeature(
  deps: CalibrationFeatureDeps = defaultCalibrationFeatureDeps,
): QueueFeature<ScoredItem, HumanQueueRankContext> {
  return {
    name: 'calibration',
    weight: 8,
    description:
      'Bet-implied risk: failed fix-survival bets (this bounced before) + open bets’ bad-outcome expectation × the bettor’s Brier-earned trust weight (P-041; inert until armed).',
    async score(items, _ctx) {
      const out = new Map<string, FeatureValue>();
      if (items.length === 0 || !(await deps.isEnabled())) return out;
      let signals: CalibrationQueueSignals;
      try {
        signals = await deps.loadSignals(items.map((i) => i.id));
      } catch (err) {
        console.warn(
          '[queue-ranker] calibration signal read failed — contributing 0:',
          err instanceof Error ? err.message : err,
        );
        return out;
      }
      const trust = new Map(signals.scores.map((s) => [weightKey(s.predictor, s.domain), s.weight]));
      const betsBySubject = new Map<string, PredictionRow[]>();
      for (const bet of signals.openBets) {
        const list = betsBySubject.get(bet.subjectId);
        if (list) list.push(bet);
        else betsBySubject.set(bet.subjectId, [bet]);
      }
      for (const item of items) {
        const reasons: string[] = [];
        let value = 0;
        const bounced = signals.bouncedBySubject.get(item.id) ?? 0;
        if (bounced > 0) {
          value += bounced * BOUNCED_FIX_VALUE;
          reasons.push(`fix bounced ${bounced}× before (failed fix-survival bet${bounced > 1 ? 's' : ''})`);
        }
        const bets = betsBySubject.get(item.id) ?? [];
        for (const bet of bets) {
          const w = trust.get(weightKey(bet.predictor, bet.domain)) ?? NEUTRAL_WEIGHT;
          const expectation = badOutcomeExpectation(bet.domain, bet.probability);
          const contribution = expectation * w;
          if (contribution <= 0) continue;
          value += contribution;
          reasons.push(
            `${bet.predictor} bets p=${bet.probability.toFixed(2)} on ${bet.domain} ` +
              `(bad-outcome ${expectation.toFixed(2)} × trust ${w.toFixed(2)})`,
          );
        }
        if (value > 0) {
          out.set(item.id, {
            value,
            reasons,
            attach: { calibration: { bounced, openBets: bets.length } },
          });
        }
      }
      return out;
    },
  };
}

export const calibrationFeature: QueueFeature<ScoredItem, HumanQueueRankContext> =
  makeCalibrationFeature();
