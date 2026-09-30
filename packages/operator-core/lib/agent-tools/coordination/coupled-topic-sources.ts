/**
 * coupled-topic-sources.ts — the PRODUCTION reads behind P-023's coupled-topic
 * projection (plan `unified-agent-state-plane-2026-07-27`, rulings D-081/D-082).
 *
 * WHY A SEPARATE MODULE. `coord/coupled-topics.ts` is pure: coupled peers +
 * plain maps in, topics out, no PG. That is what makes it unit-testable without
 * a database and what keeps its no-widening guarantee structural. This file is
 * the only part that touches a store, and it is INJECTED as
 * `CoupledTopicSources` rather than imported by the derivation — the same split
 * as coupling-derivation.ts / coupling-sources.ts in P-013.
 *
 * ⚠ EVERY READ IS ROSTER-BOUNDED, BY CONSTRUCTION. `peerWorkItems` is only ever
 * called with ownerIds that `deriveCouplings` already filtered through the
 * caller's own roster, and `itemTopics` only with refs those peers hold. So the
 * projection can re-rank what a reader can already see and can never widen it
 * (D-044 / D-081 (b)).
 *
 * ⚠ ZERO WRITES. Nothing here inserts `coord_entity_subscriptions` or
 * `predicate_watches` rows — this is a PULL projection recomputed per read
 * (D-081 (c)). Any push belongs to P-021 surprisal, in its own item.
 *
 * ⚠ THE ID SPACE IS `work_items.feature_id`, NOT plan-item ids (D-082). Topic
 * tags are `coord_links` rows with src_kind='issue' and src_ref = a work-item id
 * (`WI-…`/`EI-…`). The roster's `claimedItems` holds PLAN-ITEM ids (`P-023`)
 * from `plan_item_claims` and would match nothing — verified against the
 * producer before this was built. `taken_by` is the field that yields the right
 * id space.
 */
import type { CoupledTopicSources, CoupledTopicFeedItem } from '../../coord/coupled-topics';
import { coordSql, coordWorkspaceId, coordHasPgFastPath } from './log';
import { topicFeed } from '../../topics-feed';

/** Hard cap on how many held work-items are considered, across all peers. */
export const COUPLED_TOPIC_ITEM_CAP = 200;

/** Hard cap on tag rows read for those items. */
export const COUPLED_TOPIC_TAG_ROW_CAP = 500;

/** The `coord_links` src_kind that work-items (both `WI-` and `EI-`) are tagged
 *  under. Single kind for the whole issue family — verified in production. */
export const WORK_ITEM_TAG_SRC_KIND = 'issue';

/**
 * ownerId → the work-item ids that owner currently holds.
 *
 * Reads `taken_by`, which is the CURRENT holder (cleared on release/complete),
 * so the projection narrows on its own as claims are dropped — no cleanup path
 * and nothing to go stale, which is the shape D-044 requires.
 */
export async function fetchPeerWorkItems(
  ownerIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  const ids = [...new Set(ownerIds.map((o) => o.trim()).filter(Boolean))];
  if (ids.length === 0 || !coordHasPgFastPath()) return out;

  try {
    const sql = coordSql();
    const rows = await sql<{ taken_by: string; items: string[] }[]>`
      SELECT taken_by, array_agg(feature_id ORDER BY feature_id) AS items
        FROM harness_shared.work_items
       WHERE taken_by = ANY(${ids}::text[])
         AND feature_id IS NOT NULL
       GROUP BY taken_by`;
    // Cap in JS rather than in SQL: an array slice with a bound parameter is a
    // portability hazard across the sql template layers, and the group is small.
    for (const r of rows) {
      if (r?.taken_by) out.set(r.taken_by, (r.items ?? []).slice(0, COUPLED_TOPIC_ITEM_CAP));
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * work-item id → the topic slugs it is tagged with.
 *
 * Batched deliberately: `listObjectTags` is one round-trip PER OBJECT, and this
 * runs behind a read that may hold a dozen refs. Same table and predicate the
 * `PgTaggableStore` uses (`rel='tagged'`), scoped to the coord workspace.
 */
export async function fetchItemTopics(
  refs: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(refs.map((r) => r.trim()).filter(Boolean))];
  if (ids.length === 0 || !coordHasPgFastPath()) return out;

  try {
    const sql = coordSql();
    const rows = await sql<{ src_ref: string; dst_ref: string }[]>`
      SELECT src_ref, dst_ref
        FROM harness_shared.coord_links
       WHERE workspace_id = ${coordWorkspaceId()}
         AND src_kind = ${WORK_ITEM_TAG_SRC_KIND}
         AND dst_kind = 'topic'
         AND rel = 'tagged'
         AND src_ref = ANY(${ids}::text[])
       ORDER BY src_ref, dst_ref
       LIMIT ${COUPLED_TOPIC_TAG_ROW_CAP}`;
    for (const r of rows) {
      if (!r?.src_ref || !r?.dst_ref) continue;
      const list = out.get(r.src_ref);
      if (list) list.push(r.dst_ref);
      else out.set(r.src_ref, [r.dst_ref]);
    }
  } catch {
    return out;
  }
  return out;
}

/** Build the injected source set for one coupled-topic read. */
export function coupledTopicSourcesFor(): CoupledTopicSources {
  return {
    peerWorkItems: fetchPeerWorkItems,
    itemTopics: fetchItemTopics,
    feedForTopic: async (topic: string): Promise<readonly CoupledTopicFeedItem[]> => topicFeed(topic),
  };
}
