/**
 * topic-hysteresis — the auto-subscribe / auto-UNsubscribe state machine for
 * ambient-semantic-push-2026-07-14 (Phase 4, P-008), built to plan D-009.
 *
 * D-009's thesis: auto-sub WITHOUT auto-unsub is a ratchet — the subscription
 * set grows monotonically, every stale topic keeps a seat in the matcher
 * candidate pool + the injection-door budget, and that accumulated noise IS the
 * Clippy failure this plan guards against. So subscribe and unsubscribe are one
 * mechanism with five parts, ALL implemented here as a pure per-tick transition:
 *
 *   1. HYSTERESIS — subscribe when cursor↔topic relevance holds ≥ an ENTER
 *      threshold for an enter-dwell (N consecutive journal ticks); unsubscribe
 *      when it stays < a LOWER exit threshold for a LONGER exit-dwell. The
 *      threshold GAP + asymmetric dwell is what stops flapping at the boundary.
 *   2. STALENESS BACKSTOP — a topic with no delivered/pulled hit in K ticks
 *      unsubscribes regardless of residual weak similarity (kills the forever-
 *      lukewarm topic).
 *   3. PROVENANCE GUARD — only AUTO subscriptions may be auto-unsubscribed;
 *      MANUAL ones (deliberate topics:subscribe / owner-directed) are never
 *      silently removed — only FLAGGED with a removal suggestion.
 *   4. BOUNDED SET — the auto-managed set is capped; overflow evicts the
 *      lowest-relevance auto-sub (the utilization-eviction principle, carry
 *      D-005 lineage).
 *   5. SILENT-BUT-JOURNALED — every change emits one fully-explainable typed
 *      notice (visible to the agent per the P-008 item, never a silent mutation);
 *      re-subscription on re-approach is cheap (the enter-dwell just applies
 *      again).
 *
 * All thresholds/dwells are named constants (no runtime self-adaptation — carry
 * D-001); they belong on the carry P-023 per-session config surface when the
 * live matcher wires up. This module is PURE: relevance samples in, next state +
 * notices out. It never touches coord — computing the relevance (cursor↔topic
 * overlap via lexical-cursor) and ACTUATING the notices (real topics:subscribe /
 * unsubscribe transport) are the deferred {@link SubscriptionActuator} live leg.
 */

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/** How a subscription came to be. Only 'auto' is auto-removable (D-009 §3). */
export type SubscriptionProvenance = 'auto' | 'manual';

/** Per-(session,topic) tracking state — the machine's memory between ticks. */
export interface TopicSubscription {
  topic: string;
  provenance: SubscriptionProvenance;
  subscribed: boolean;
  /** Consecutive ticks relevance held ≥ enterThreshold (toward subscribe). */
  aboveEnterStreak: number;
  /** Consecutive ticks relevance stayed < exitThreshold (toward unsubscribe). */
  belowExitStreak: number;
  /** Ticks since the last delivered/pulled hit (the staleness backstop clock). */
  ticksSinceHit: number;
  /** The most recent relevance sample (bounded-set eviction key + notice detail). */
  lastRelevance: number;
  /** Tick the current subscription began (age / stable tie-break). */
  subscribedAtTick?: number;
  /** Manual-only: a removal suggestion has already been emitted for the current
   *  drift episode (so it fires once, not every tick — reset when relevance
   *  recovers above exitThreshold). */
  removalSuggested?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config (named constants — carry P-023 surface when live; carry D-001)
// ─────────────────────────────────────────────────────────────────────────────

export interface HysteresisParams {
  /** Subscribe when relevance ≥ this… */
  enterThreshold: number;
  /** …for this many CONSECUTIVE ticks. */
  enterDwell: number;
  /** Unsubscribe when relevance < this (LOWER than enter — the hysteresis gap)… */
  exitThreshold: number;
  /** …for this many consecutive ticks (LONGER than enterDwell — asymmetric dwell). */
  exitDwell: number;
  /** No delivered/pulled hit in this many ticks ⇒ unsubscribe regardless of similarity. */
  stalenessTicks: number;
  /** Cap on the AUTO-managed subscribed set; overflow evicts the weakest. */
  maxAutoSubscriptions: number;
}

export const DEFAULT_HYSTERESIS_PARAMS: HysteresisParams = {
  enterThreshold: 0.5,
  enterDwell: 3,
  exitThreshold: 0.25,
  exitDwell: 6,
  stalenessTicks: 20,
  maxAutoSubscriptions: 8,
};

/** Sanity-check the hysteresis invariants (the gap + asymmetry that prevent
 *  flapping). Returns human-readable warnings; empty ⇒ sane. PURE — a caller /
 *  config validator surfaces these; nothing here throws. */
export function validateHysteresisParams(p: HysteresisParams): string[] {
  const w: string[] = [];
  if (p.exitThreshold > p.enterThreshold) w.push('exitThreshold should be ≤ enterThreshold (no hysteresis gap ⇒ flapping)');
  if (p.exitDwell < p.enterDwell) w.push('exitDwell should be ≥ enterDwell (asymmetric dwell prevents flapping)');
  if (p.maxAutoSubscriptions < 1) w.push('maxAutoSubscriptions must be ≥ 1');
  if (p.enterDwell < 1) w.push('enterDwell must be ≥ 1');
  if (p.exitDwell < 1) w.push('exitDwell must be ≥ 1');
  if (p.stalenessTicks < 1) w.push('stalenessTicks must be ≥ 1');
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
// The typed change notice (D-009 §5 — visible, never a silent mutation)
// ─────────────────────────────────────────────────────────────────────────────

export type SubscriptionChangeKind = 'subscribed' | 'unsubscribed' | 'overflow-evicted' | 'manual-removal-suggested';

export interface SubscriptionNotice {
  kind: SubscriptionChangeKind;
  topic: string;
  provenance: SubscriptionProvenance;
  /** The relevance that drove the change (for the dashboard + explanation). */
  relevance: number;
  /** A fully-explainable one-liner (D-009 §5: "unsubscribed <topic> — no term
   *  overlap in last N journal entries"). */
  reason: string;
}

function notice(kind: SubscriptionChangeKind, s: TopicSubscription, reason: string): SubscriptionNotice {
  return { kind, topic: s.topic, provenance: s.provenance, relevance: s.lastRelevance, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// The tick
// ─────────────────────────────────────────────────────────────────────────────

export interface HysteresisTickInput {
  /** Current tracked state (auto + manual). Not mutated — the tick returns fresh state. */
  subscriptions: TopicSubscription[];
  /** This tick's relevance per topic (cursor↔topic overlap ∈ [0,1]). A tracked
   *  topic ABSENT from the map got no sample ⇒ treated as relevance 0 (drifted). */
  relevanceByTopic: ReadonlyMap<string, number>;
  /** Topics that got a delivered/pulled hit this tick (reset the staleness clock). */
  hitTopics?: ReadonlySet<string>;
  /** Monotonic tick index (journal-update counter). */
  tick: number;
  params?: HysteresisParams;
}

export interface HysteresisTickResult {
  /** Next tracked state (fully-drifted auto candidates pruned; sorted by topic). */
  subscriptions: TopicSubscription[];
  /** Every change this tick, in a deterministic order. */
  notices: SubscriptionNotice[];
}

/**
 * Advance the subscription machine one tick. PURE — clones the input state,
 * folds this tick's relevance samples through the five D-009 rules, and returns
 * the next state plus every typed notice. Deterministic: same inputs ⇒ same
 * outputs, stable ordering. Nothing here subscribes/unsubscribes for real — the
 * notices are the instructions the (deferred) {@link SubscriptionActuator} would
 * carry out.
 */
export function hysteresisTick(input: HysteresisTickInput): HysteresisTickResult {
  const params = input.params ?? DEFAULT_HYSTERESIS_PARAMS;
  const tick = input.tick;
  const hits = input.hitTopics ?? new Set<string>();
  const notices: SubscriptionNotice[] = [];

  // Clone for purity.
  const next = new Map<string, TopicSubscription>();
  for (const s of input.subscriptions) next.set(s.topic, { ...s });

  // 0. Update counters for every tracked topic + this tick's sampled topics.
  const topics = new Set<string>([...next.keys(), ...input.relevanceByTopic.keys()]);
  for (const topic of topics) {
    const relevance = input.relevanceByTopic.get(topic) ?? 0;
    let s = next.get(topic);
    if (!s) {
      s = { topic, provenance: 'auto', subscribed: false, aboveEnterStreak: 0, belowExitStreak: 0, ticksSinceHit: 0, lastRelevance: 0 };
      next.set(topic, s);
    }
    s.aboveEnterStreak = relevance >= params.enterThreshold ? s.aboveEnterStreak + 1 : 0;
    if (relevance >= params.exitThreshold) {
      s.belowExitStreak = 0;
      s.removalSuggested = false; // recovered — a fresh drift may suggest again
    } else {
      s.belowExitStreak += 1;
    }
    s.ticksSinceHit = hits.has(topic) ? 0 : s.ticksSinceHit + 1;
    s.lastRelevance = relevance;
  }

  // 1–3. Unsubscribe / suggest / subscribe transitions.
  for (const s of next.values()) {
    if (s.subscribed) {
      // The staleness backstop targets the forever-LUKEWARM topic (D-009 §2:
      // "regardless of residual WEAK similarity") — a topic currently at/above
      // the enter threshold is hot, re-earning its seat on similarity grounds,
      // and exempt (else a hot topic whose hits lag would cycle sub→stale→sub).
      const stale = s.ticksSinceHit >= params.stalenessTicks && s.lastRelevance < params.enterThreshold;
      const drifted = s.belowExitStreak >= params.exitDwell;
      if (!stale && !drifted) continue;

      if (s.provenance === 'auto') {
        s.subscribed = false;
        const reason = stale
          ? `no delivered/pulled hit in ${s.ticksSinceHit} ticks (staleness backstop)`
          : `relevance < ${params.exitThreshold} for ${s.belowExitStreak} consecutive ticks (drift)`;
        s.belowExitStreak = 0;
        notices.push(notice('unsubscribed', s, reason));
      } else if (!s.removalSuggested) {
        // Manual: never silently removed — flag once (D-009 §3).
        s.removalSuggested = true;
        const reason = stale
          ? `manual subscription stale (${s.ticksSinceHit} ticks, no hit) — consider removing`
          : `manual subscription drifted (relevance < ${params.exitThreshold} for ${s.belowExitStreak} ticks) — consider removing`;
        notices.push(notice('manual-removal-suggested', s, reason));
      }
    } else if (s.provenance === 'auto' && s.aboveEnterStreak >= params.enterDwell) {
      s.subscribed = true;
      s.subscribedAtTick = tick;
      s.belowExitStreak = 0;
      // Fresh staleness clock: the backstop measures "SUBSCRIBED but never hit".
      // Hits only land on subscribed topics, so the clock accumulated while
      // merely tracked would otherwise carry in ≥ stalenessTicks and stale-kick
      // the brand-new subscription next tick — a permanent 2-tick flap.
      s.ticksSinceHit = 0;
      s.removalSuggested = false;
      notices.push(notice('subscribed', s, `relevance ≥ ${params.enterThreshold} for ${s.aboveEnterStreak} consecutive ticks (enter-dwell met)`));
    }
  }

  // 4. Bounded set: cap the auto-subscribed set, evicting the weakest (lowest
  //    relevance, then most-stale, then topic) for a deterministic outcome.
  const autoSubs = [...next.values()].filter((s) => s.subscribed && s.provenance === 'auto');
  if (autoSubs.length > params.maxAutoSubscriptions) {
    const weakestFirst = autoSubs
      .slice()
      .sort((a, b) => a.lastRelevance - b.lastRelevance || b.ticksSinceHit - a.ticksSinceHit || a.topic.localeCompare(b.topic));
    for (const s of weakestFirst.slice(0, autoSubs.length - params.maxAutoSubscriptions)) {
      s.subscribed = false;
      s.aboveEnterStreak = 0; // must re-earn an enter-dwell to come back (anti cap-flap)
      notices.push(notice('overflow-evicted', s, `auto-subscription set over cap ${params.maxAutoSubscriptions}; evicted lowest-relevance (${s.lastRelevance.toFixed(2)})`));
    }
  }

  // 5b. Prune fully-drifted, unsubscribed AUTO candidates — keeps the tracked set
  //     bounded; re-subscription on re-approach is cheap (enter-dwell reapplies).
  //     Manual topics are always kept (deliberate).
  const kept: TopicSubscription[] = [];
  for (const s of next.values()) {
    // A zero-overlap, unsubscribed auto candidate with no enter-streak is dead —
    // drop it immediately (re-subscription on re-approach is cheap, D-009 §5).
    // Keep it while it still carries ANY relevance or is climbing toward enter.
    const deadAuto = s.provenance === 'auto' && !s.subscribed && s.lastRelevance === 0 && s.aboveEnterStreak === 0;
    if (!deadAuto) kept.push(s);
  }
  kept.sort((a, b) => a.topic.localeCompare(b.topic));

  // Notices in a deterministic order: kind rank, then topic.
  const kindRank: Record<SubscriptionChangeKind, number> = { unsubscribed: 0, 'overflow-evicted': 1, 'manual-removal-suggested': 2, subscribed: 3 };
  notices.sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || a.topic.localeCompare(b.topic));

  return { subscriptions: kept, notices };
}

// ─────────────────────────────────────────────────────────────────────────────
// The DEFERRED live leg (a named seam; nothing here calls it)
// ─────────────────────────────────────────────────────────────────────────────

/** The LIVE actuation seam (DEFAULT-OFF, later phase): carry a tick's notices out
 *  to the real coord transport — topics:subscribe on 'subscribed', topics:
 *  unsubscribe on 'unsubscribed'/'overflow-evicted', deliver 'manual-removal-
 *  suggested' as a typed agent notice. Host-coupled (writes live subscriptions);
 *  stays staged until the owner arms it, mirroring the sibling cores' injected
 *  drivers. This module produces the notices; it never applies them. */
export type SubscriptionActuator = (notices: SubscriptionNotice[], opts: { sessionId: string }) => Promise<void>;
