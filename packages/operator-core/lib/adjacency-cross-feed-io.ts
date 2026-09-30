/**
 * adjacency-cross-feed-io — the LIVE leg of the P-013 sustained-adjacency
 * journal cross-feed (ambient-semantic-push-2026-07-14, plan D-006/D-009). It
 * stitches the pure banded fold (adjacency-cross-feed.ts) to the SHARED
 * per-tick snapshot the P-004 collision tick already computed (compute once,
 * feed both matchers — this module never re-reads peer cursors), the carried
 * state (adjacency-state-store, migration 614), the REAL topic + subscription
 * rows (topic-subscription-store — the same rows topics:subscribe writes), and
 * the delivery rail (push-delivery-store.enqueuePush):
 *
 *   the collision tick's collisionCandidates snapshot  →  adjacencyTick against
 *   the session's CARRIED state (banded [enter, duplicate): at/above duplicate
 *   EXITS 'escalated-to-collision' so P-004 takes over, never double-firing)  →
 *   on each ENTER edge, ensure + subscribe the deterministic SHARED topic (both
 *   sides derive the same 'adj:…' slug with zero coordination — each side's own
 *   tick subscribes its own owner) and notice SELF on the rail  →  on each EXIT
 *   edge, unsubscribe the slug RECORDED at enter (the pure fold re-derives
 *   names from CURRENT terms, which drift) and notice SELF  →  CROSS-FEED: this
 *   turn's journal note, when on-topic for a still-adjacent pair, rides to the
 *   PEER's owner as one bounded 'topic-sub' one-liner (~1 line/turn; the rail's
 *   per-class budgets + the P-011 ledger apply at delivery like any push).
 *
 * SEAM: journal:record-turn fires {@link boundedAdjacencyTick} right after the
 * P-004 collision tick, feeding it that tick's snapshot + owner map + this
 * turn's journal note. DEFAULT-OFF behind PAPERCUSP_AMBIENT_CURSOR — the caller
 * gates on the flag BEFORE importing this module. Bounded + fail-soft: an
 * advisory cross-feed must never slow or fail the journal write.
 *
 * State is REQUIRED, not an optimization: the band only ENTERs after the
 * overlap holds in [enter, duplicate) for enterDwell CONSECUTIVE ticks, and a
 * tick is one turn-end — the streak must survive across turns (migration 614),
 * which the transcript does not do. The carried topics-by-peer map is equally
 * load-bearing: exits must unsubscribe the slug subscribed at ENTER, and the
 * cross-feed's on-topic test must use the ENTER terms, not the drifted ones.
 *
 * Cross-machine etiquette (disclosed design choices):
 *   • an enter-edge subscribe failure is NOT retried — enter edges are
 *     one-shot; the conservative miss costs one topic feed, never noise. The
 *     entered notice only fires for an APPLIED subscribe (mirrors P-008's
 *     applied-only contract), but the peer topic is still recorded so the
 *     cross-feed works (it delivers direct to the peer's owner, not via the
 *     subscription).
 *   • P-008's reconciler will see the adjacency subscription as MANUAL (it did
 *     not create it) and never cull it — correct: ITS lifecycle must not fight
 *     THIS machine's exits. When this machine unsubscribes on exit, P-008
 *     records its permanent opt-out marker for the slug — also correct: auto
 *     must not re-subscribe a topic the adjacency already left.
 *   • a shared slug held by TWO still-adjacent peers is only unsubscribed when
 *     the LAST of them exits.
 */
import { withBoundedTimeout } from './bounded-timeout';
import {
  adjacencyTick,
  crossFeedPush,
  DEFAULT_ADJACENCY_PARAMS,
  type AdjacencyParams,
} from './adjacency-cross-feed';
import { makePush, type CollisionLike } from './ambient-push';
import type { AdjacencyPeerTopic } from './adjacency-state-store';

/** Budget for the turn-end adjacency tick (mirrors the sibling matcher ticks —
 *  the same fire-and-forget turn-end advisory contract). */
export const ADJACENCY_TICK_BUDGET_MS = 4_000;

/** The fixed score an adjacency enter/exit notice rides the rail with — same
 *  rationale as TOPIC_NOTICE_SCORE (topic-matcher-io): a state-change notice's
 *  delivery-worthiness is a property of its KIND, not of the residual band
 *  score that triggered it (an exit fires precisely when similarity left the
 *  band). 0.75 clears every class floor; severity stays 'info', so drones
 *  remain gated per D-004 regardless. */
export const ADJACENCY_NOTICE_SCORE = 0.75;

/** Cap the adjacent peers cross-fed in one tick (safety bound — the tracked set
 *  is already bounded by the fold's maxTrackedPeers). */
export const CROSS_FEED_MAX_PEERS = 4;

export interface AdjacencyTickIoInput {
  /** The self session whose fresh cursor triggered the collision tick. */
  selfSessionId: string;
  /** Self's coord identity — subscriptions + notices are keyed on it. No owner
   *  ⇒ no tick (nothing to subscribe or notice without an identity). */
  selfOwnerId: string | null;
  /** THE shared per-tick snapshot — the collision tick's collisionCandidates
   *  output, handed over so both matchers ride one peer read + index build. */
  snapshot: CollisionLike[];
  /** owner_id per live peer session in the snapshot (from the collision tick).
   *  Recorded at the enter edge as the cross-feed delivery axis. */
  ownerBySession?: ReadonlyMap<string, string | null>;
  /** This turn's journal note (the cross-feed source). Absent ⇒ no cross-feed
   *  this tick (the adjacency machine still advances). */
  journalNote?: string | null;
  /** Band/hysteresis params override (default DEFAULT_ADJACENCY_PARAMS). */
  params?: AdjacencyParams;
  /** Cross-feed peer cap override (default CROSS_FEED_MAX_PEERS). */
  maxCrossFeedPeers?: number;
}

export interface AdjacencyTickIoResult {
  /** false when there was no owner identity (nothing to actuate). */
  ran: boolean;
  /** The tick counter after this tick. */
  tick: number;
  /** Adjacency enter edges this tick. */
  entered: number;
  /** Adjacency exit edges this tick (drifted / staleness / escalated). */
  exited: number;
  /** Shared-topic subscriptions actually written this tick. */
  subscribed: number;
  /** Shared-topic unsubscribes actually written this tick. */
  unsubscribed: number;
  /** Cross-feed one-liners enqueued to adjacent peers this tick. */
  crossFed: number;
  /** Total rail rows enqueued this tick (notices + cross-feed). */
  enqueued: number;
}

const ZERO_RESULT: AdjacencyTickIoResult = {
  ran: false,
  tick: 0,
  entered: 0,
  exited: 0,
  subscribed: 0,
  unsubscribed: 0,
  crossFed: 0,
  enqueued: 0,
};

/**
 * Run one adjacency tick for `selfSessionId` over the collision tick's shared
 * snapshot. Folds the banded hysteresis against carried state, actuates the
 * shared-topic subscription edges, persists the next state (+ topics-by-peer
 * bookkeeping), notices SELF for every applied edge, and cross-feeds this
 * turn's on-topic journal note to each still-adjacent peer's owner. Assumes
 * the feature is enabled (the caller gates on PAPERCUSP_AMBIENT_CURSOR before
 * importing this module). Not bounded here — {@link boundedAdjacencyTick} owns
 * the budget + the fail-soft guarantee.
 */
export async function runAdjacencyTick(input: AdjacencyTickIoInput): Promise<AdjacencyTickIoResult> {
  if (!input.selfOwnerId) return { ...ZERO_RESULT };
  const ownerId = input.selfOwnerId;
  const params = input.params ?? DEFAULT_ADJACENCY_PARAMS;
  const ownerBySession = input.ownerBySession ?? new Map<string, string | null>();

  const [stateStore, topicStore, deliveryStore] = await Promise.all([
    import('./adjacency-state-store'),
    import('./topic-subscription-store'),
    import('./push-delivery-store'),
  ]);

  const carry = await stateStore.loadAdjacencyState(input.selfSessionId);
  const nextTick = carry.tick + 1;
  const result = adjacencyTick({
    states: carry.states,
    snapshot: input.snapshot,
    tick: nextTick,
    params,
  });

  const topics: Record<string, AdjacencyPeerTopic> = { ...carry.topics };
  let entered = 0;
  let exited = 0;
  let subscribed = 0;
  let unsubscribed = 0;
  let crossFed = 0;
  let enqueued = 0;

  /** Enqueue one enter/exit notice to SELF — fail-soft like every rail write. */
  const noticeSelf = async (topic: string, terms: string[], teaser: string): Promise<void> => {
    try {
      const push = makePush({
        matcherKind: 'topic-sub',
        handle: { kind: 'topic', ref: topic, query: terms.length > 0 ? terms : [topic] },
        teaser,
        score: ADJACENCY_NOTICE_SCORE,
      });
      await deliveryStore.enqueuePush({
        targetOwnerId: ownerId,
        targetSessionId: input.selfSessionId,
        matcherKind: 'topic-sub',
        severity: push.severity,
        handleKind: push.handle.kind,
        handleRef: push.handle.ref,
        handleQuery: push.handle.query,
        teaser: push.teaser,
        score: push.score,
        sourceSessionId: null,
      });
      enqueued += 1;
    } catch {
      /* fail-soft: the applied change stays visible via topics:list */
    }
  };

  for (const n of result.notices) {
    if (n.kind === 'adjacency-entered') {
      entered += 1;
      // Record the peer topic FIRST (the cross-feed delivers direct to the
      // peer's owner and must work even if the subscribe below fails).
      topics[n.sessionId] = {
        topic: n.topic,
        terms: [...n.sharedTerms],
        peerOwnerId: ownerBySession.get(n.sessionId) ?? carry.topics[n.sessionId]?.peerOwnerId ?? null,
      };
      try {
        // Idempotent create — the peer's own tick races the same slug; first
        // writer wins. Title/description are derived from the symmetric terms
        // so both sides would write identical rows anyway.
        await topicStore.ensureTopicFor({
          slug: n.topic,
          title: `adjacent lanes: ${n.sharedTerms.slice(0, 3).join(', ')}`,
          description:
            'Auto-created shared topic for two adjacent work lanes (ambient adjacency cross-feed, P-013). On-topic journal notes cross-post here as one-liners.',
          createdBy: ownerId,
        });
        await topicStore.subscribeTopicFor(ownerId, n.topic, 'digest');
        subscribed += 1;
      } catch {
        // One-shot edge, not retried (disclosed in the module doc): skip the
        // notice — like P-008, only APPLIED changes are noticed.
        continue;
      }
      await noticeSelf(n.topic, n.sharedTerms, `adjacency: entered with ${n.sessionId} — sharing topic '${n.topic}' (${n.reason})`);
    } else {
      exited += 1;
      // Unsubscribe the slug RECORDED at enter, not the notice's re-derived
      // name (shared terms drift between enter and exit).
      const rec = topics[n.sessionId];
      delete topics[n.sessionId];
      if (!rec) continue; // never subscribed (enter predates the live leg, or the subscribe failed)
      const slugStillHeld = Object.entries(topics).some(
        ([peer, t]) => t.topic === rec.topic && result.states.some((s) => s.sessionId === peer && s.adjacent),
      );
      if (!slugStillHeld) {
        try {
          await topicStore.unsubscribeTopicFor(ownerId, rec.topic);
          unsubscribed += 1;
        } catch {
          /* fail-soft: a missed unsubscribe leaves one stale digest sub, never noise */
        }
      }
      await noticeSelf(rec.topic, rec.terms, `adjacency: exited with ${n.sessionId} — topic '${rec.topic}' (${n.reason})`);
    }
  }

  // CROSS-FEED: this turn's journal note rides to each still-adjacent peer's
  // owner when it is on-topic for THAT pair (crossFeedPush returns null for an
  // off-topic note — never cross-posted). Strongest adjacencies first;
  // per-push fail-soft so one bad row never drops the rest.
  const note = (input.journalNote ?? '').trim();
  if (note) {
    const maxPeers = Math.max(0, input.maxCrossFeedPeers ?? CROSS_FEED_MAX_PEERS);
    const adjacent = result.states
      .filter((s) => s.adjacent && topics[s.sessionId])
      .sort((a, b) => b.lastScore - a.lastScore || a.sessionId.localeCompare(b.sessionId))
      .slice(0, maxPeers);
    for (const st of adjacent) {
      const rec = topics[st.sessionId]!;
      // The peer's owner may have been unresolvable at enter; fill it in when
      // this tick's snapshot knows it.
      const liveOwner = ownerBySession.get(st.sessionId);
      if (liveOwner !== undefined && liveOwner !== rec.peerOwnerId) {
        rec.peerOwnerId = liveOwner;
      }
      if (!rec.peerOwnerId) continue; // nowhere to deliver
      const push = crossFeedPush({
        note,
        sessionId: input.selfSessionId,
        topic: rec.topic,
        topicTerms: rec.terms,
      });
      if (!push) continue; // off-topic for this pair
      try {
        await deliveryStore.enqueuePush({
          targetOwnerId: rec.peerOwnerId,
          targetSessionId: st.sessionId,
          matcherKind: push.matcherKind,
          severity: push.severity,
          handleKind: push.handle.kind,
          handleRef: push.handle.ref,
          handleQuery: push.handle.query,
          teaser: push.teaser,
          score: push.score,
          sourceSessionId: push.sourceSessionId ?? null,
        });
        crossFed += 1;
        enqueued += 1;
      } catch {
        /* fail-soft: skip this peer's line */
      }
    }
  }

  // GC the topics map to peers the fold still tracks (evicted peers drop out).
  const tracked = new Set(result.states.map((s) => s.sessionId));
  for (const peer of Object.keys(topics)) {
    if (!tracked.has(peer)) delete topics[peer];
  }

  await stateStore.saveAdjacencyState({
    sessionId: input.selfSessionId,
    ownerId,
    tick: nextTick,
    states: result.states,
    topics,
  });

  return { ran: true, tick: nextTick, entered, exited, subscribed, unsubscribed, crossFed, enqueued };
}

/**
 * The seam journal:record-turn calls right after the collision tick, feeding it
 * that tick's snapshot: bounded + fail-soft adjacency tick. Never throws, never
 * hangs past {@link ADJACENCY_TICK_BUDGET_MS}; degrades to a no-op result. The
 * caller checks PAPERCUSP_AMBIENT_CURSOR BEFORE importing this module, so the
 * default-off path never loads the adjacency code.
 */
export async function boundedAdjacencyTick(input: AdjacencyTickIoInput): Promise<AdjacencyTickIoResult> {
  const { value } = await withBoundedTimeout(runAdjacencyTick(input), {
    fallback: ZERO_RESULT,
    timeoutMs: ADJACENCY_TICK_BUDGET_MS,
    label: 'turn-end-adjacency-tick',
  });
  return value;
}
