/**
 * coupled-topics.ts — P-023's COUPLED-TOPIC FEED: the topics a caller should be
 * seeing because its COUPLED PEERS are working objects tagged with them.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-023. Scoping ruling: D-081,
 * amended by D-082 (the producer correction below).
 *
 * WHY THIS EXISTS. `topics:feed` could only ever answer "what is happening in
 * topic X" for a topic you already knew to name. Nothing derived WHICH topics
 * were live for YOU. This composes the coupling graph (P-013) with the topic
 * index (topics-feed.ts) to answer that: coupled peers → the work-items they
 * hold → the topics those items are tagged → the feed.
 *
 * ⚠ A DERIVED PROJECTION, NOT A SUBSCRIPTION (D-044, D-081 (c)). Every call
 * recomputes from live coupling and holds nothing: zero rows are written to
 * `coord_entity_subscriptions`, no `predicate_watches`, no wake path. That is
 * the whole point of the shape — a stored subscription minted from an ephemeral
 * signal accumulates and is never cleaned up, whereas this NARROWS by itself the
 * moment coupling decays, because there is no state to go stale. PUSH out of
 * this is P-021 surprisal's job, in its own item, never coupling alone.
 *
 * ⚠ RE-RANKING ONLY, NEVER WIDENING. The peers come from `deriveCouplings`,
 * which has already filtered every edge to the caller's own roster, and this
 * module derives topics ONLY from objects those peers hold. So a topic can
 * surface here only if a peer the caller can already see is working an object
 * tagged with it — the "out-of-audience topic never appears" guarantee holds
 * STRUCTURALLY (by the roster boundary it inherits) rather than by an access
 * check that could be wrong.
 *
 * ⚠ ON `canReadCell` (D-081 (b)). The item text names `canReadCell` as the
 * audience gate; that is a FALSE LEAD and the ruling records why. A topic is not
 * a cell and has no CellSpec (cell-registry.ts: visibility is
 * workspace|owner|role|harness|work_item), so calling it would either be a no-op
 * or require minting a parallel cell per topic — precisely the "second
 * access-adjacent surface that can drift from D-042 and fail open" that D-044
 * (c) forbids. The enforcement is the roster boundary above, at the OBJECT
 * layer. Should this ever read a REAL cell, it MUST take `getCell(cell, reader)`
 * / `listCells(reader)` and never the `Unchecked` accessors (D-042 / D-078 (c)).
 *
 * ⚠⚠ D-082 — THE PRODUCER CORRECTION, AND WHY THE OBVIOUS FIELD IS THE WRONG
 * ONE. D-081 planned to key this off the roster's `claimedItems`, which is
 * indeed on every presence row. Verified against the PRODUCER before building
 * (presence-tier1.ts), `claimedItems` is filled from `plan_item_claims` and so
 * holds PLAN-ITEM ids (`P-023`) — while topic tags are `coord_links` rows keyed
 * by WORK-ITEM id (`WI-…`/`EI-…`, src_kind='issue'). Those two id spaces never
 * intersect, so the "obvious" composition would have matched ZERO rows in
 * production forever while every hand-built fixture passed. The correct field is
 * `workItemClaims` — which presence-tier1 explicitly does NOT emit in the
 * compact payload. Hence {@link CoupledTopicSources.peerWorkItems}: an INJECTED,
 * roster-bounded read, exactly like the lock-hold source in P-013, rather than a
 * roster field that does not carry what its name suggests.
 *
 * This is the same class as the `currentFiles` near-miss on P-013
 * (EI-18772330418885814, class filed as EI-18801000813757662): a structural
 * interface plus hand-built fixtures tests code against ITSELF and cannot
 * distinguish "wrong field" from "real field that is always empty". Only a check
 * against the producer can, which is why the contract test in this module's
 * suite pins the id space rather than trusting the shape.
 *
 * ⚠ PURE AND TOTAL in its core, like the coupling derivation before it: the
 * derivation takes plain data and is unit-testable without PG, and every IO leg
 * is injected and fail-soft, so a dead source degrades ONE signal instead of
 * taking down the read that called it.
 */
import type { DerivedCoupling } from './couplings';

/**
 * All this module needs of a coupling: WHO. It never reads the signal — so it
 * takes the narrowed shape rather than the full {@link DerivedCoupling}, which
 * lets a caller holding the union's `CoupledPeer` (declared edges included) pass
 * peers straight in without inventing a `relation` no derivation produced.
 */
type CoupledOwner = Pick<DerivedCoupling, 'ownerId'>;

/** How many coupled peers to NAME in a topic's `because` before summarising. */
export const COUPLED_TOPIC_PEERS_NAMED = 2;

/** Hard cap on derived topics, so a peer holding a heavily-tagged item cannot
 *  turn a presence-adjacent read into an unbounded payload. */
export const COUPLED_TOPIC_CAP = 25;

/** One topic derived from the caller's coupling graph, with WHY it surfaced. */
export interface CoupledTopic {
  topic: string;
  /** Coupled peers whose held work carries this topic (sorted, de-duped). */
  viaPeers: string[];
  /** The work-items that tagged it (sorted, de-duped). */
  viaItems: string[];
  /** Human-readable signal, e.g. "su-abc12 is working WI-6386, tagged gate-dx". */
  because: string;
}

/** A topic plus its feed — the last mile, reusing `topicFeed`'s entries. */
export interface CoupledTopicFeed extends CoupledTopic {
  items: readonly CoupledTopicFeedItem[];
}

/** Structural mirror of `TopicFeedItem` (topics-feed.ts), kept local so the pure
 *  core does not import the PG-backed module. */
export interface CoupledTopicFeedItem {
  kind: string;
  ref: string;
  title: string | null;
  state: string | null;
}

/** The bounded, caller-scoped reads this projection needs. Each is OPTIONAL: an
 *  unavailable source degrades that one leg, never the whole derivation. */
export interface CoupledTopicSources {
  /** ownerId → WORK-ITEM ids that owner currently holds. Bounded to the roster
   *  by the caller. ⚠ NOT the roster's `claimedItems` — see D-082 above. */
  peerWorkItems?: (ownerIds: readonly string[]) => Promise<ReadonlyMap<string, readonly string[]>>;
  /** work-item id → the topic slugs it is tagged with (`rel='tagged'`). */
  itemTopics?: (refs: readonly string[]) => Promise<ReadonlyMap<string, readonly string[]>>;
  /** topic → its feed entries. Only called for topics that already survived the
   *  derivation, so the fan-out is bounded by {@link COUPLED_TOPIC_CAP}. */
  feedForTopic?: (topic: string) => Promise<readonly CoupledTopicFeedItem[]>;
}

function cleanId(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function uniqueSorted(v: Iterable<string>): string[] {
  return [...new Set(v)].sort();
}

/** Render a topic's signal, naming a bounded number of peers. */
function becausePhrase(peers: readonly string[], items: readonly string[]): string {
  const named = peers.slice(0, COUPLED_TOPIC_PEERS_NAMED);
  const rest = peers.length - named.length;
  const who = rest > 0 ? `${named.join(', ')} (+${rest} more)` : named.join(', ');
  const verb = peers.length === 1 ? 'is' : 'are';
  const what = items.length === 1 ? items[0] : `${items.length} items`;
  return `${who} ${verb} working ${what}`;
}

/**
 * THE PURE CORE: coupled peers × the items they hold × those items' tags →
 * topics, each with the peers and items that produced it.
 *
 * Total and order-stable: peers are visited in the order `couplings` gives, and
 * the output is sorted by topic so two readers with the same inputs derive the
 * same projection. A peer with no items, an item with no tags, and a malformed
 * entry all contribute nothing rather than throwing.
 *
 * ⚠ THE `self` FILTER IS NOT COSMETIC. The caller's own items are excluded so
 * the projection answers "what are my PEERS into that I am not" — a topic you
 * are already working is not news, and including it would let a caller's own
 * work inflate its own feed.
 */
export function deriveTopicsFromPeerItems(
  selfOwnerId: string,
  couplings: readonly CoupledOwner[],
  peerItems: ReadonlyMap<string, readonly string[]>,
  itemTopics: ReadonlyMap<string, readonly string[]>,
): CoupledTopic[] {
  const self = cleanId(selfOwnerId);
  const byTopic = new Map<string, { peers: Set<string>; items: Set<string> }>();

  const seenPeer = new Set<string>();
  for (const c of couplings) {
    const peer = cleanId((c ?? ({} as CoupledOwner)).ownerId);
    if (!peer || peer === self || seenPeer.has(peer)) continue;
    seenPeer.add(peer);

    const items = peerItems.get(peer);
    if (!Array.isArray(items)) continue;

    for (const rawRef of items) {
      const ref = cleanId(rawRef);
      if (!ref) continue;
      const topics = itemTopics.get(ref);
      if (!Array.isArray(topics)) continue;

      for (const rawTopic of topics) {
        const topic = cleanId(rawTopic);
        if (!topic) continue;
        let entry = byTopic.get(topic);
        if (!entry) {
          entry = { peers: new Set(), items: new Set() };
          byTopic.set(topic, entry);
        }
        entry.peers.add(peer);
        entry.items.add(ref);
      }
    }
  }

  const out: CoupledTopic[] = [];
  for (const [topic, { peers, items }] of byTopic) {
    const viaPeers = uniqueSorted(peers);
    const viaItems = uniqueSorted(items);
    out.push({ topic, viaPeers, viaItems, because: becausePhrase(viaPeers, viaItems) });
  }

  // Most-corroborated first (more coupled peers on a topic ⇒ more relevant),
  // then by topic for a stable tie-break, then capped.
  out.sort((a, b) => b.viaPeers.length - a.viaPeers.length || a.topic.localeCompare(b.topic));
  return out.slice(0, COUPLED_TOPIC_CAP);
}

/**
 * THE ORCHESTRATOR: derive the caller's coupled topics, optionally with each
 * topic's feed attached.
 *
 * FAIL-SOFT PER LEG, deliberately: a thrown/rejected source contributes nothing
 * while the rest still land, and a topic whose FEED read fails still surfaces
 * with an empty `items` rather than vanishing — knowing the topic is live is
 * most of the value, and losing it to an enrichment error would be the worse
 * failure. Callers pass `withFeed: false` when they only want the topic list.
 */
export async function deriveCoupledTopics(
  selfOwnerId: string,
  couplings: readonly CoupledOwner[],
  sources: CoupledTopicSources = {},
  opts: { withFeed?: boolean } = {},
): Promise<CoupledTopicFeed[]> {
  const self = cleanId(selfOwnerId);
  if (!self) return [];

  const peers = uniqueSorted(
    couplings.map((c) => cleanId((c ?? ({} as CoupledOwner)).ownerId)).filter((id) => id && id !== self),
  );
  if (peers.length === 0) return [];

  const settle = async <T>(f: (() => Promise<T>) | undefined, fallback: T): Promise<T> => {
    if (!f) return fallback;
    try {
      return await f();
    } catch {
      return fallback;
    }
  };

  const empty = new Map<string, readonly string[]>() as ReadonlyMap<string, readonly string[]>;
  const peerItems = await settle(
    sources.peerWorkItems ? () => sources.peerWorkItems!(peers) : undefined,
    empty,
  );

  const refs = uniqueSorted(
    [...peerItems.values()].flatMap((v) => (Array.isArray(v) ? v.map(cleanId) : [])).filter(Boolean),
  );
  if (refs.length === 0) return [];

  const itemTopics = await settle(
    sources.itemTopics ? () => sources.itemTopics!(refs) : undefined,
    empty,
  );

  const derived = deriveTopicsFromPeerItems(self, couplings, peerItems, itemTopics);
  if (opts.withFeed === false || !sources.feedForTopic) {
    return derived.map((d) => ({ ...d, items: [] }));
  }

  return Promise.all(
    derived.map(async (d) => ({
      ...d,
      items: await settle(() => sources.feedForTopic!(d.topic), [] as readonly CoupledTopicFeedItem[]),
    })),
  );
}
