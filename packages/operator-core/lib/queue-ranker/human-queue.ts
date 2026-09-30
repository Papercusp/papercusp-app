/**
 * The human review queue's assembled ranker (P-040 / FB-12) — the ONE place
 * the human lane gets its order (D-005). The `improvements:digest` tool, the
 * `learning.improvements` sync resolver, and the weekly owner digest routine
 * all rank through here, so the tool, the tab, and the inbox can never drift.
 *
 * Registry today: blocking-impact (weight 1) — exactly B-08's live ordering.
 * Calibration (P-041), deferral interest (P-042), and the owner preference
 * model (P-043) land by APPENDING to HUMAN_QUEUE_FEATURES — never by sorting
 * the queue anywhere else. Every ranked item carries `rank` (per-feature
 * value × weight breakdown) alongside the B-08 `impact` struct existing
 * consumers read.
 */

import type { ImprovementDigest, ScoredItem } from '../harness/improvements/digest';
import type { ImpactRankedItem } from '../harness/improvements/blocking-impact';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import type { IssueLinkCounts } from '../issues-engineer';
import { bettableFirstFeature } from './bettable-first-feature';
import {
  blockingImpactFeature,
  defaultHumanQueueRankDeps,
  type HumanQueueRankContext,
  type HumanQueueRankDeps,
} from './blocking-impact-feature';
import { calibrationFeature } from './calibration-feature';
import { deferralInterestFeature } from './deferral-interest-feature';
import { ownerPreferenceFeature } from './owner-preference-feature';
import { describeFeatures, rankQueue, type QueueFeature, type RankBreakdown } from './ranker';

/**
 * The named-feature registry for the human lane. ORDER IS THE BREAKDOWN
 * ORDER; weights are the tunables D-005 wants inspectable. New economic
 * signals append here.
 */
export const HUMAN_QUEUE_FEATURES: readonly QueueFeature<ScoredItem, HumanQueueRankContext>[] = [
  blockingImpactFeature,
  // P-042 / FB-14: learned deferral pricing — contributes 0 until the lane is
  // armed (flag ON + a trained model), so registering it is order-preserving.
  deferralInterestFeature,
  // P-043 / FB-15: implicit owner-attention model — contributes 0 until armed
  // (flag ON) and near-0 until interaction history accumulates past the
  // model's evidence floors, so registering it is order-preserving too.
  ownerPreferenceFeature,
  // P-041 / FB-13: bet-implied risk (bounced fixes + open bets × bettor
  // trust) — contributes 0 until armed (the same flag gates the capture
  // seams, so no bets exist while dark); order-preserving until then.
  calibrationFeature,
  // su-ideate-learning-substrate P-007: ideas shipping a complete cheap
  // falsifiable experiment (payload.ideation, D-006) surface first + carry the
  // machine-checkable `bettable` flag. Contributes 0 and attaches nothing for
  // items without ideation, so registering it is order-preserving too.
  bettableFirstFeature,
];

/** The registry as data — name/weight/description per feature. */
export function humanQueueRankerSpec(): Array<{ name: string; weight: number; description: string }> {
  return describeFeatures(HUMAN_QUEUE_FEATURES);
}

/** A human-queue item with its B-08 impact AND its full rank breakdown. */
export type RankedHumanQueueItem = ImpactRankedItem & { rank: RankBreakdown };

export interface HumanQueueRankInputs {
  candidates?: readonly ImprovementCandidate[];
  linkCounts?: ReadonlyMap<string, IssueLinkCounts>;
}

/**
 * The digest read path's enrichment step: rank `humanQueue` through the
 * feature registry, each item carrying `impact` + `rank`. Additive — every
 * other digest field is untouched, so the `improvements:digest` tool shape
 * and the Learning tab resolver stay one shape and can't drift.
 *
 * Ties (equal weighted score) break on the prior triage score, then id —
 * deterministic, and byte-identical to B-08's ordering while blocking-impact
 * is the sole feature.
 */
export async function applyHumanQueueRanking<D extends ImprovementDigest>(
  digest: D,
  inputs: HumanQueueRankInputs = {},
  deps: HumanQueueRankDeps = defaultHumanQueueRankDeps,
): Promise<D & { humanQueue: RankedHumanQueueItem[] }> {
  const ctx: HumanQueueRankContext = {
    digest,
    candidates: inputs.candidates,
    linkCounts: inputs.linkCounts,
    deps,
  };
  const ranked = await rankQueue(digest.humanQueue, ctx, {
    features: HUMAN_QUEUE_FEATURES,
    getKey: (item) => item.id,
    tieBreak: (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  });
  // The blocking-impact feature attaches `impact` to every item (pinned by
  // human-queue.test.ts), which is what upgrades Ranked<ScoredItem> to
  // RankedHumanQueueItem.
  return { ...digest, humanQueue: ranked as RankedHumanQueueItem[] };
}
