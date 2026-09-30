/**
 * Feature #1 of the one ranker (P-040): blocking impact — what is actually
 * waiting on each human-lane item. CONSUMES consume-edges B-08's module
 * (harness/improvements/blocking-impact.ts) — the scoring semantics live
 * there and only there; this file is the adapter onto the feature registry
 * plus the defensive link-degree fetch (a link-read failure degrades to
 * link-free ranking — the Learning tab must never 500 because the edge store
 * hiccuped).
 *
 * Attaches the full `impact` struct onto each ranked item, so every existing
 * consumer of B-08's shape (HumanQueueDrain, the weekly owner digest) keeps
 * reading exactly what it read before.
 */

import type { ImprovementDigest, ScoredItem } from '../harness/improvements/digest';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import {
  buildImpactItemContext,
  computeBlockingImpact,
} from '../harness/improvements/blocking-impact';
import { issueLinkCounts, type IssueLinkCounts } from '../issues-engineer';
import type { FeatureValue, QueueFeature } from './ranker';

/** Injectable IO (unit tests inject fakes; production reads coord_links). */
export interface HumanQueueRankDeps {
  readLinkCounts: (ids: readonly string[]) => Promise<Map<string, IssueLinkCounts>>;
}

export const defaultHumanQueueRankDeps: HumanQueueRankDeps = { readLinkCounts: issueLinkCounts };

/** The context every human-queue feature scores against. */
export interface HumanQueueRankContext {
  /** The digest the queue came from — recurrence + dup clusters live here. */
  digest: Pick<ImprovementDigest, 'recurringSignatures' | 'likelyDuplicates'>;
  /** Raw candidates (payload fields ScoredItem doesn't carry — watchdogKey). */
  candidates?: readonly ImprovementCandidate[];
  /** Pre-fetched link degrees; when absent the feature fetches via deps. */
  linkCounts?: ReadonlyMap<string, IssueLinkCounts>;
  deps: HumanQueueRankDeps;
}

export const blockingImpactFeature: QueueFeature<ScoredItem, HumanQueueRankContext> = {
  name: 'blocking-impact',
  weight: 1,
  description:
    'Downstream cost of leaving this undecided: `blocks` edges, inbound references, open re-captures, near-dups, watchdog persistence, severity — × log staleness (B-08).',
  async score(items, ctx) {
    let linkCounts = ctx.linkCounts;
    if (!linkCounts && items.length > 0) {
      try {
        linkCounts = await ctx.deps.readLinkCounts(items.map((i) => i.id));
      } catch (err) {
        console.warn(
          '[queue-ranker] link-count read failed — blocking-impact ranks without link degree:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    const { recurrenceById, dupClusterSizeById } = buildImpactItemContext(ctx.digest);
    const out = new Map<string, FeatureValue>();
    for (const item of items) {
      const impact = computeBlockingImpact(item, {
        candidates: ctx.candidates,
        linkCounts,
        recurrence: recurrenceById.get(item.id),
        dupClusterSize: dupClusterSizeById.get(item.id),
      });
      out.set(item.id, { value: impact.score, reasons: impact.reasons, attach: { impact } });
    }
    return out;
  },
};
