/**
 * topic-matcher-io — the LIVE leg of the P-008 topic auto-subscribe matcher
 * (ambient-semantic-push-2026-07-14, plan D-009). It stitches the pure
 * subscribe/unsubscribe machine (topic-hysteresis.ts) to the live cursor
 * (session-cursor-store), the topic vocabulary + REAL subscription rows
 * (topic-subscription-store → coord_topics / coord_entity_subscriptions — the
 * same rows topics:subscribe writes), the carried per-session state
 * (topic-hysteresis-store, migration 613), and the delivery rail
 * (push-delivery-store.enqueuePush):
 *
 *   read self's fresh cursor  →  score it against each live topic's CENTROID
 *   (slug + title + description through the same buildCursor/scoreCursorOverlap
 *   lens every matcher uses)  →  RECONCILE the carried TopicSubscription state
 *   with the real subscription rows (see below)  →  hysteresisTick  →  ACTUATE
 *   each notice (real subscribe/unsubscribe)  →  save the next state  →  enqueue
 *   every applied change as a typed 'topic-sub' notice to SELF on the P-003 rail
 *   (visible, never silent — D-009 §5; the rail selects/tallies/injects at
 *   delivery time).
 *
 * RECONCILIATION (the multi-writer contract): subscriptions are OWNER-keyed and
 * shared with humans + other sessions; this machine's carried state is SESSION-
 * keyed. Every tick starts by reconciling the two:
 *   • a real subscription this machine did not create is MANUAL — never silently
 *     removed, only flagged (D-009 §3);
 *   • a carried AUTO subscription whose real row is gone was cancelled OUTSIDE
 *     this machine (a human / topics:unsubscribe / a peer session) — it becomes a
 *     permanent manual+unsubscribed OPT-OUT marker, so the machine neither
 *     re-subscribes (fighting the human is the Clippy failure) nor re-removes it.
 *   This also makes multiple sessions of one owner safe: each session only ever
 *   auto-removes subscriptions it created itself.
 *
 * SEAM: journal:record-turn fires {@link boundedTopicTick} right AFTER the P-006
 * dead-end tick (a fresh cursor is the tick trigger). DEFAULT-OFF behind
 * PAPERCUSP_AMBIENT_CURSOR — the caller gates on the flag BEFORE importing this
 * module. Bounded + fail-soft: an advisory subscription tick must never slow or
 * fail the journal write.
 *
 * State is REQUIRED, not an optimization: the machine only subscribes after the
 * relevance holds for enterDwell CONSECUTIVE ticks (and exits after a longer
 * dwell), and a tick is one turn-end — so the streaks MUST survive across turns
 * (topic-hysteresis-store), which the transcript does not do.
 *
 * DEFERRED-with-reason (live-fleet-gated, not faked here):
 *   • hit attribution ({@link TopicTickInput.hitTopics} — "which topics got a
 *     delivered/pulled hit this tick" resets the staleness clock): needs the
 *     substrate fan-out delivery ledger, only observable on live traffic. The
 *     empty default means the staleness backstop culls forever-LUKEWARM topics
 *     earlier than a hit-aware clock would — the conservative (less noise)
 *     direction; hot topics are exempt by design.
 *   • centroid enrichment with tagged-object titles (topics-feed.topicFeed):
 *     deferred to keep the tick bounded — the v1 centroid is slug+title+
 *     description, one cheap read for the whole vocabulary.
 *   • per-recipient session-CLASS gating of the notices rides the delivery rail
 *     (prepareAmbientPushBlock), not this enqueue leg (D-004: drones never see
 *     info — a drone's own subscription changes surface via topics:list instead).
 */
import { withBoundedTimeout } from './bounded-timeout';
import {
  hysteresisTick,
  DEFAULT_HYSTERESIS_PARAMS,
  type HysteresisParams,
  type TopicSubscription,
} from './topic-hysteresis';
import {
  buildCursor,
  scoreCursorOverlap,
  type BuildCursorOptions,
  type CursorOverlap,
  type LexicalCursor,
} from './lexical-cursor';
import { makePush } from './ambient-push';

/** Budget for the turn-end topic tick (mirrors the collision/dead-end ticks —
 *  the same fire-and-forget turn-end advisory contract). */
export const TOPIC_TICK_BUDGET_MS = 4_000;

/** Cap the live topics scored in one tick (the vocabulary is agent-curated and
 *  small; the cap is a safety bound, not a working limit). */
export const TOPIC_SCAN_LIMIT = 50;

/** Auto-subscriptions land in DIGEST mode (D-006 volume tiering): the coarse
 *  routing layer delivers a coalesced view; the agent upgrades to 'full'
 *  deliberately via topics:subscribe if it wants every update. */
export const AUTO_SUB_DELIVERY_MODE = 'digest' as const;

/** The fixed score a subscription-change notice rides the rail with. The class
 *  floor gates MATCH strength; a state-change notice's delivery-worthiness is a
 *  property of its kind, not of the residual similarity that triggered it — an
 *  UNSUBSCRIBE fires precisely when relevance has decayed below every floor, so
 *  scoring notices by relevance would silently swallow the exact notices P-008
 *  requires to be visible. 0.75 clears every class floor; severity stays 'info'
 *  (SEVERITY_BY_MATCHER), so drones remain gated per D-004 regardless. */
export const TOPIC_NOTICE_SCORE = 0.75;

/** Bound the shared-term list carried in a notice's re-pull query. */
const NOTICE_MAX_TERMS = 5;

/** The minimal topic shape the centroid needs (TopicRow satisfies it). */
export interface TopicLike {
  slug: string;
  title?: string | null;
  description?: string | null;
}

/**
 * The text a topic's centroid cursor is built from: slug (plus its word-split
 * form, so 'mac-vm-recovery' also contributes 'mac vm recovery'), title, and the
 * one-sentence description. PURE.
 */
export function topicCentroidText(topic: TopicLike): string {
  const slug = topic.slug ?? '';
  const slugWords = slug.replace(/[-_]+/g, ' ').trim();
  const parts = [slug, slugWords !== slug ? slugWords : '', topic.title ?? '', topic.description ?? ''];
  return parts.filter((p) => p && p.trim()).join(' ');
}

/**
 * Score the agent's cursor against each topic's centroid. Returns the full
 * {@link CursorOverlap} per slug (the tick needs the score; the notices reuse the
 * shared terms as the legible "why" / re-pull query). Topics with no scorable
 * text are skipped. PURE.
 */
export function topicRelevance(
  cursor: LexicalCursor,
  topics: TopicLike[],
  opts: { cursorOptions?: BuildCursorOptions; idf?: (term: string) => number } = {},
): Map<string, CursorOverlap> {
  const out = new Map<string, CursorOverlap>();
  for (const t of topics) {
    if (!t || typeof t.slug !== 'string' || !t.slug) continue;
    const text = topicCentroidText(t);
    if (!text.trim()) continue;
    const topicCursor = buildCursor([text], opts.cursorOptions);
    out.set(t.slug, scoreCursorOverlap(cursor, topicCursor, opts.idf ? { idf: opts.idf } : {}));
  }
  return out;
}

/**
 * Reconcile the carried per-session state with the REAL active subscription rows
 * (the multi-writer contract in the module doc). PURE — returns fresh state:
 *   • real row, not tracked          → track as manual+subscribed (never ours to remove);
 *   • real row, tracked unsubscribed → someone subscribed outside the machine ⇒ manual+subscribed;
 *   • tracked subscribed, row GONE   → cancelled outside the machine ⇒ the permanent
 *     manual+unsubscribed OPT-OUT marker (auto never re-subscribes a topic a human removed);
 *   • otherwise                      → carried unchanged.
 */
export function reconcileSubscriptions(
  carried: TopicSubscription[],
  realTopicSlugs: ReadonlySet<string>,
): TopicSubscription[] {
  const next = new Map<string, TopicSubscription>();
  for (const s of carried) next.set(s.topic, { ...s });

  for (const s of next.values()) {
    const real = realTopicSlugs.has(s.topic);
    if (s.subscribed && !real) {
      s.provenance = 'manual';
      s.subscribed = false;
      s.aboveEnterStreak = 0;
      s.belowExitStreak = 0;
      s.removalSuggested = false;
    } else if (!s.subscribed && real) {
      s.provenance = 'manual';
      s.subscribed = true;
      s.removalSuggested = false;
    }
  }
  for (const slug of realTopicSlugs) {
    if (!next.has(slug)) {
      next.set(slug, {
        topic: slug,
        provenance: 'manual',
        subscribed: true,
        aboveEnterStreak: 0,
        belowExitStreak: 0,
        ticksSinceHit: 0,
        lastRelevance: 0,
      });
    }
  }
  return [...next.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}

export interface TopicTickInput {
  /** The self session whose fresh cursor triggers this tick. */
  selfSessionId: string;
  /** Self's coord identity — subscriptions are keyed on it. No owner ⇒ no tick
   *  (nothing to reconcile or actuate without an identity). */
  selfOwnerId: string | null;
  /** Topic scan cap override (default TOPIC_SCAN_LIMIT). */
  maxTopics?: number;
  /** Hysteresis params override (default DEFAULT_HYSTERESIS_PARAMS). */
  params?: HysteresisParams;
  /** DEFERRED hit-attribution seam (see module doc): topics that got a
   *  delivered/pulled hit this tick. Default: none. */
  hitTopics?: ReadonlySet<string>;
}

export interface TopicTickResult {
  /** false when there was no owner identity or no self cursor yet. */
  ran: boolean;
  /** The tick counter after this tick. */
  tick: number;
  /** Auto-subscriptions actually written this tick. */
  subscribed: number;
  /** Auto-unsubscribes (drift/staleness) actually written this tick. */
  unsubscribed: number;
  /** Overflow evictions actually written this tick. */
  evicted: number;
  /** Manual-removal suggestions raised this tick (flag-only, no write). */
  suggested: number;
  /** Typed notices enqueued on the delivery rail this tick. */
  enqueued: number;
}

const ZERO_RESULT: TopicTickResult = {
  ran: false,
  tick: 0,
  subscribed: 0,
  unsubscribed: 0,
  evicted: 0,
  suggested: 0,
  enqueued: 0,
};

/**
 * Run one topic tick for `selfSessionId`. Reads its just-persisted cursor, the
 * live topic vocabulary, and the owner's REAL subscriptions; reconciles + folds
 * the hysteresis against carried state; actuates each change against the real
 * subscription store; persists the next state; and enqueues every APPLIED change
 * as a typed notice to self. Assumes the feature is enabled (the caller gates on
 * PAPERCUSP_AMBIENT_CURSOR before importing this module). Not bounded here —
 * {@link boundedTopicTick} owns the budget + the fail-soft guarantee.
 *
 * Actuation is per-notice fail-soft, and the persisted state is PATCHED on an
 * actuation failure (a failed subscribe is saved as still-unsubscribed, a failed
 * unsubscribe as still-subscribed) so the edge retries on a later tick instead
 * of the carried state lying about the real rows — an unpatched mismatch would
 * read as an EXTERNAL change at the next reconcile and trip the opt-out. A
 * notice is only enqueued for a change that actually applied.
 */
export async function runTopicTick(input: TopicTickInput): Promise<TopicTickResult> {
  if (!input.selfOwnerId) return { ...ZERO_RESULT };
  const ownerId = input.selfOwnerId;
  const maxTopics = input.maxTopics ?? TOPIC_SCAN_LIMIT;
  const params = input.params ?? DEFAULT_HYSTERESIS_PARAMS;

  const [cursorStore, stateStore, subscriptionStore, deliveryStore] = await Promise.all([
    import('./session-cursor-store'),
    import('./topic-hysteresis-store'),
    import('./topic-subscription-store'),
    import('./push-delivery-store'),
  ]);

  // Self's freshly-persisted cursor is the tick input. No cursor yet ⇒ nothing to do.
  const selfRow = await cursorStore.getSessionCursorRow(input.selfSessionId);
  if (!selfRow) return { ...ZERO_RESULT };
  const cursor = cursorStore.rowToCursor(selfRow);

  const [topics, realSubs, carry] = await Promise.all([
    subscriptionStore.listLiveTopics(maxTopics),
    subscriptionStore.listTopicSubscriptions(ownerId),
    stateStore.loadTopicState(input.selfSessionId),
  ]);

  const realSlugs = new Set(realSubs.map((s) => s.target_ref));
  const subscriptions = reconcileSubscriptions(carry.subscriptions, realSlugs);

  const overlaps = topicRelevance(cursor, topics);
  const relevanceByTopic = new Map<string, number>();
  for (const [slug, o] of overlaps) relevanceByTopic.set(slug, o.score);

  const nextTick = carry.tick + 1;
  const result = hysteresisTick({
    subscriptions,
    relevanceByTopic,
    hitTopics: input.hitTopics,
    tick: nextTick,
    params,
  });

  const stateByTopic = new Map(result.subscriptions.map((s) => [s.topic, s]));
  let subscribed = 0;
  let unsubscribed = 0;
  let evicted = 0;
  let suggested = 0;
  let enqueued = 0;

  for (const n of result.notices) {
    let applied = true;
    if (n.kind === 'subscribed') {
      try {
        await subscriptionStore.subscribeTopicFor(ownerId, n.topic, AUTO_SUB_DELIVERY_MODE);
        subscribed += 1;
      } catch {
        applied = false;
        const s = stateByTopic.get(n.topic);
        if (s) s.subscribed = false; // retry the enter edge on a later tick
      }
    } else if (n.kind === 'unsubscribed' || n.kind === 'overflow-evicted') {
      try {
        await subscriptionStore.unsubscribeTopicFor(ownerId, n.topic);
        if (n.kind === 'unsubscribed') unsubscribed += 1;
        else evicted += 1;
      } catch {
        applied = false;
        const s = stateByTopic.get(n.topic);
        if (s) s.subscribed = true; // retry the exit edge on a later tick
      }
    } else {
      suggested += 1; // manual-removal-suggested: flag-only, never a write
    }
    if (!applied) continue;

    // The typed change notice (D-009 §5) — rides the shared rail to self. A
    // notice-enqueue fault never undoes the applied change (the change stays
    // visible via topics:list); fail-soft like every rail write.
    try {
      const terms = overlaps.get(n.topic)?.sharedTerms.slice(0, NOTICE_MAX_TERMS).map((t) => t.term) ?? [];
      const push = makePush({
        matcherKind: 'topic-sub',
        handle: { kind: 'topic', ref: n.topic, query: terms.length > 0 ? terms : [n.topic] },
        teaser: `topic auto-subscribe: ${n.kind} '${n.topic}' — ${n.reason}`,
        score: TOPIC_NOTICE_SCORE,
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
      /* fail-soft: the change applied; only the notice was lost */
    }
  }

  await stateStore.saveTopicState({
    sessionId: input.selfSessionId,
    ownerId,
    tick: nextTick,
    subscriptions: result.subscriptions,
  });

  return { ran: true, tick: nextTick, subscribed, unsubscribed, evicted, suggested, enqueued };
}

/**
 * The seam journal:record-turn calls after the dead-end tick: bounded +
 * fail-soft topic tick. Never throws, never hangs past
 * {@link TOPIC_TICK_BUDGET_MS}; degrades to a no-op result. The caller checks
 * PAPERCUSP_AMBIENT_CURSOR BEFORE importing this module, so the default-off
 * path never loads the topic-matcher code.
 */
export async function boundedTopicTick(input: TopicTickInput): Promise<TopicTickResult> {
  const { value } = await withBoundedTimeout(runTopicTick(input), {
    fallback: ZERO_RESULT,
    timeoutMs: TOPIC_TICK_BUDGET_MS,
    label: 'turn-end-topic-tick',
  });
  return value;
}
