/**
 * collision-hysteresis — the SUSTAINED-collision detector for
 * ambient-semantic-push-2026-07-14 (Phase 4 P-004), built to plan D-006 + the
 * D-010 lexical reframe.
 *
 * lexical-cursor.collisionCandidates already answers "which peer sessions'
 * cursors overlap mine RIGHT NOW, and by how much" — one snapshot. But a single
 * momentary overlap spike must NOT fire a collision push: two agents brushing
 * the same term for one tick are not converging. Only a SUSTAINED convergence is
 * worth interrupting a peer over. This module is the pure per-tick hysteresis
 * fold over the time-series of those snapshot scores, keyed per peer session:
 *   • ENTER a sustained collision only after the overlap holds ≥ enterThreshold
 *     for enterDwell consecutive ticks ("single spikes do nothing");
 *   • EXIT only after it holds < exitThreshold for exitDwell consecutive ticks —
 *     an asymmetric gap so a collision that dips briefly is not dropped (the
 *     same hysteresis idiom as topic-hysteresis, keyed on peer id / overlap
 *     score instead of topic / relevance);
 *   • a STALENESS backstop: a colliding peer that vanishes from the snapshot
 *     entirely (moved on) clears FASTER than the full drift dwell — absence is
 *     stronger evidence of divergence than a merely-low score;
 *   • a BOUNDED tracked set: cap the peers under watch, evicting the weakest
 *     NON-colliding ones (an active collision is never evicted).
 * On the ENTER edge it renders the collision push via ambient-push.collisionToPush
 * (critical severity, data-not-directive) — reusing the exact bridge the snapshot
 * path would use, so the fold decides WHEN and collisionToPush decides HOW.
 *
 * Same pure-core / deferred-live-leg split as the rest of the build. The live leg
 * (feeding real per-tick snapshots from the live inverted index + delivering the
 * enter-edge pushes over the coord rail) rides later phases DEFAULT-OFF behind
 * {@link CollisionFeed}; nothing here calls it. PURE, deterministic, no-LLM.
 */

import { collisionToPush, type PushObject, type CollisionLike } from './ambient-push';

// ─────────────────────────────────────────────────────────────────────────────
// State + params
// ─────────────────────────────────────────────────────────────────────────────

/** Per-peer sustained-collision state, carried tick to tick. */
export interface CollisionState {
  /** The peer session this state tracks. */
  sessionId: string;
  /** In a sustained (past-the-hysteresis) collision right now. */
  colliding: boolean;
  /** Consecutive ticks with overlap ≥ enterThreshold (resets on any dip). */
  aboveEnterStreak: number;
  /** Consecutive ticks with overlap < exitThreshold (resets on any recovery). */
  belowExitStreak: number;
  /** Ticks since this peer last appeared in a snapshot at all (0 = seen now). */
  ticksSinceSeen: number;
  /** The most recent overlap score seen for this peer. */
  lastScore: number;
  /** The most recent shared terms (the legible "why", for the enter-edge push). */
  lastSharedTerms: string[];
  /** The tick a sustained collision was entered (for age / debugging). */
  enteredAtTick?: number;
}

export interface CollisionHysteresisParams {
  /** Overlap must reach this to build the enter streak. */
  enterThreshold: number;
  /** Consecutive ≥-enter ticks required to ENTER (kills single spikes). */
  enterDwell: number;
  /** Overlap below this builds the exit streak. */
  exitThreshold: number;
  /** Consecutive <-exit ticks required to EXIT (asymmetric: ≥ enterDwell). */
  exitDwell: number;
  /** A colliding peer unseen for this many ticks clears via the backstop —
   *  set BELOW exitDwell so a vanished peer exits faster than a merely-low one. */
  stalenessTicks: number;
  /** Cap the tracked-peer set; overflow evicts the weakest non-colliding. */
  maxTrackedPeers: number;
}

/** Deliberate defaults (no runtime self-adaptation — carry D-001). Asymmetric:
 *  3 ticks to enter, 6 to drift out, but only 4 to clear on outright absence. */
export const DEFAULT_COLLISION_HYSTERESIS_PARAMS: CollisionHysteresisParams = {
  // Ratified from the P-005 seeded drill + live shadow sample (D-021): with
  // IDF enabled, 0.4 misses realistically worded same-bug convergence in small
  // peer corpora; 0.30 retained 0/70 false positives in the measured sample.
  enterThreshold: 0.3,
  enterDwell: 3,
  exitThreshold: 0.2,
  exitDwell: 6,
  stalenessTicks: 4,
  maxTrackedPeers: 16,
};

/** Warn (never throw) on params that would defeat the hysteresis: no gap between
 *  the thresholds, or a non-asymmetric dwell that lets a collision flap. */
export function validateCollisionParams(p: CollisionHysteresisParams): string[] {
  const warnings: string[] = [];
  if (!(p.exitThreshold <= p.enterThreshold)) {
    warnings.push('exitThreshold should be ≤ enterThreshold (a hysteresis gap prevents flapping)');
  }
  if (!(p.exitDwell >= p.enterDwell)) {
    warnings.push('exitDwell should be ≥ enterDwell (asymmetric dwell — slower to exit than to enter)');
  }
  if (!(p.stalenessTicks >= 1)) warnings.push('stalenessTicks should be ≥ 1');
  if (!(p.maxTrackedPeers >= 1)) warnings.push('maxTrackedPeers should be ≥ 1');
  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notices + the tick
// ─────────────────────────────────────────────────────────────────────────────

export type CollisionChangeKind = 'collision-entered' | 'collision-cleared';

/** A visible, fully-explainable state change (never silent — mirrors the
 *  topic-hysteresis notice discipline). */
export interface CollisionNotice {
  kind: CollisionChangeKind;
  sessionId: string;
  score: number;
  reason: string;
}

export interface CollisionTickInput {
  /** The carried per-peer state (from the previous tick; [] on the first). */
  states: CollisionState[];
  /** THIS tick's snapshot collision candidates — the lexical-cursor
   *  collisionCandidates output (peers sharing ≥1 term, scored). A peer absent
   *  from this list is treated as overlap 0 for the tick. */
  snapshot: CollisionLike[];
  /** Monotonic tick counter (recorded as enteredAtTick). */
  tick: number;
  params?: CollisionHysteresisParams;
}

export interface CollisionTickResult {
  /** The next per-peer state (pure — the input is never mutated). */
  states: CollisionState[];
  /** Every state change this tick, entered-first then by session id. */
  notices: CollisionNotice[];
  /** The collision pushes for peers that JUST entered a sustained collision,
   *  most-urgent (highest overlap) first. */
  pushes: PushObject[];
}

/**
 * Advance the sustained-collision machine one tick. Deterministic pure fold:
 * clone the carried state, fold in this tick's snapshot, apply the enter/exit
 * hysteresis + staleness backstop + bounded-set eviction, and emit a typed
 * notice for every change plus a collision push on each ENTER edge. PURE.
 */
export function collisionHysteresisTick(input: CollisionTickInput): CollisionTickResult {
  const params = input.params ?? DEFAULT_COLLISION_HYSTERESIS_PARAMS;
  const tick = input.tick;

  // This tick's snapshot, by peer id (last write wins on a dup).
  const snap = new Map<string, CollisionLike>();
  for (const c of input.snapshot) {
    if (c && c.sessionId) snap.set(c.sessionId, c);
  }

  // Clone carried state (purity), then ensure every snapshot peer is tracked.
  const states = new Map<string, CollisionState>();
  for (const s of input.states) {
    states.set(s.sessionId, { ...s, lastSharedTerms: [...(s.lastSharedTerms ?? [])] });
  }
  for (const sid of snap.keys()) {
    if (!states.has(sid)) {
      states.set(sid, {
        sessionId: sid, colliding: false,
        aboveEnterStreak: 0, belowExitStreak: 0, ticksSinceSeen: 0,
        lastScore: 0, lastSharedTerms: [],
      });
    }
  }

  const notices: CollisionNotice[] = [];
  const pushCarriers: Array<{ push: PushObject; score: number; sid: string }> = [];

  for (const st of states.values()) {
    const cand = snap.get(st.sessionId);
    const seen = cand !== undefined;
    const score = seen ? cand!.overlap.score : 0;

    st.ticksSinceSeen = seen ? 0 : st.ticksSinceSeen + 1;
    if (seen) {
      st.lastScore = score;
      st.lastSharedTerms = cand!.overlap.sharedTerms.map((t) => t.term);
    }

    st.aboveEnterStreak = score >= params.enterThreshold ? st.aboveEnterStreak + 1 : 0;
    st.belowExitStreak = score < params.exitThreshold ? st.belowExitStreak + 1 : 0;

    if (!st.colliding) {
      if (st.aboveEnterStreak >= params.enterDwell) {
        st.colliding = true;
        st.enteredAtTick = tick;
        st.belowExitStreak = 0;
        notices.push({
          kind: 'collision-entered', sessionId: st.sessionId, score,
          reason: `overlap ≥ ${params.enterThreshold} sustained for ${params.enterDwell} ticks`,
        });
        // The peer is necessarily in this tick's snapshot at the enter edge
        // (the streak only advances on a ≥-enter, i.e. seen, tick).
        if (cand) pushCarriers.push({ push: collisionToPush(cand), score, sid: st.sessionId });
      }
    } else if (st.ticksSinceSeen >= params.stalenessTicks) {
      // Staleness backstop: a vanished peer clears fast.
      st.colliding = false;
      st.aboveEnterStreak = 0;
      notices.push({
        kind: 'collision-cleared', sessionId: st.sessionId, score,
        reason: `peer unseen for ${st.ticksSinceSeen} ticks (staleness backstop)`,
      });
    } else if (st.belowExitStreak >= params.exitDwell) {
      // Drift: still present but sustained below the exit threshold.
      st.colliding = false;
      st.aboveEnterStreak = 0;
      notices.push({
        kind: 'collision-cleared', sessionId: st.sessionId, score,
        reason: `overlap < ${params.exitThreshold} for ${params.exitDwell} ticks (diverged)`,
      });
    }
  }

  // GC: drop fully-gone, non-colliding peers with no momentum (cheap to re-seed
  // from a fresh snapshot — same idiom as topic-hysteresis pruning drifted subs).
  for (const [sid, st] of [...states]) {
    if (!st.colliding && st.aboveEnterStreak === 0 && st.ticksSinceSeen >= params.stalenessTicks) {
      states.delete(sid);
    }
  }

  // Bounded set: over cap ⇒ evict the weakest NON-colliding (lowest last score,
  // then most stale, then id) — an active collision is protected.
  if (states.size > params.maxTrackedPeers) {
    const evictable = [...states.values()].filter((s) => !s.colliding);
    evictable.sort(
      (a, b) => a.lastScore - b.lastScore || b.ticksSinceSeen - a.ticksSinceSeen || a.sessionId.localeCompare(b.sessionId),
    );
    let over = states.size - params.maxTrackedPeers;
    for (const s of evictable) {
      if (over <= 0) break;
      states.delete(s.sessionId);
      over -= 1;
    }
  }

  notices.sort((a, b) => {
    const rank = (a.kind === 'collision-entered' ? 0 : 1) - (b.kind === 'collision-entered' ? 0 : 1);
    return rank || a.sessionId.localeCompare(b.sessionId);
  });
  pushCarriers.sort((a, b) => b.score - a.score || a.sid.localeCompare(b.sid));

  return {
    states: [...states.values()],
    notices,
    pushes: pushCarriers.map((p) => p.push),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deferred live seam (DEFAULT-OFF — later phases, behind the host boundary)
// ─────────────────────────────────────────────────────────────────────────────

/** The live leg this pure fold defers to: produce each tick's real snapshot from
 *  the live inverted index and deliver the enter-edge pushes over the coord rail.
 *  Named so the host boundary is explicit; the fold never touches it, and it
 *  ships DEFAULT-OFF until the acceptance drills (P-005/P-007) exist. */
export type CollisionFeed = {
  snapshot(): Promise<CollisionLike[]>;
  deliver(push: PushObject): Promise<void>;
};
