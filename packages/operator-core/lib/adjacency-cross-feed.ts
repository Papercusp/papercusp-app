/**
 * adjacency-cross-feed — the sustained-adjacency journal cross-feed for
 * ambient-semantic-push-2026-07-14 (Phase 7 P-013), built to plan D-006/D-009 +
 * the D-010 lexical reframe.
 *
 * P-004 collision handles DUPLICATE work (two cursors converged so hard someone
 * should stop). P-013 handles the band BELOW that: two cursors that stay similar
 * WITHOUT being duplicates — legitimately ADJACENT lanes (two agents on two
 * halves of one feature). Neither should stop; each should ambiently see the
 * other's progress at ~1 line/turn. Mechanism:
 *   • ADJACENCY DETECTION — a per-tick hysteresis fold over the same
 *     collisionCandidates snapshots P-004 consumes, but banded: only a score in
 *     [enterThreshold, duplicateThreshold) builds the adjacency streak. At or
 *     above duplicateThreshold it is collision territory — P-004's job, and an
 *     adjacency that escalates there EXITS (reason 'escalated-to-collision') so
 *     the two matchers never double-fire on one pair.
 *   • SHARED TOPIC — on the adjacency edge both sides derive the SAME topic name
 *     from the overlap's shared terms ({@link sharedTopicName} is deterministic
 *     and the overlap is symmetric), so they rendezvous on one P-008 topic with
 *     zero coordination; the P-008 hysteresis machine handles the subscription
 *     lifecycle from there.
 *   • CROSS-FEED — each agent's ON-TOPIC journal notes cross-post to the topic
 *     as bounded one-liners ({@link crossFeedPush}): matcherKind 'topic-sub'
 *     (info severity — budget-gated per class like everything else; the P-011
 *     ledger applies).
 * The live legs (real snapshots, real topics:subscribe, real cross-posting) ride
 * behind {@link AdjacencyFeed}, DEFAULT-OFF. PURE, deterministic, no-LLM.
 */

import { extractKeywords } from './lexical-cursor';
import { makePush, type PushObject, type CollisionLike } from './ambient-push';

// ─────────────────────────────────────────────────────────────────────────────
// State + params
// ─────────────────────────────────────────────────────────────────────────────

export interface AdjacencyState {
  sessionId: string;
  /** In a sustained adjacency (past the hysteresis) right now. */
  adjacent: boolean;
  /** Consecutive ticks with overlap inside the adjacency band. */
  inBandStreak: number;
  /** Consecutive ticks with overlap below exitThreshold. */
  belowExitStreak: number;
  /** Ticks since this peer last appeared in a snapshot (0 = seen now). */
  ticksSinceSeen: number;
  lastScore: number;
  lastSharedTerms: string[];
  enteredAtTick?: number;
}

export interface AdjacencyParams {
  /** Band floor: overlap must reach this to build the adjacency streak… */
  enterThreshold: number;
  /** …and stay BELOW this (at/above = duplicate/collision territory, P-004's). */
  duplicateThreshold: number;
  /** Consecutive in-band ticks required to enter (single spikes do nothing). */
  enterDwell: number;
  /** Overlap below this builds the exit streak. */
  exitThreshold: number;
  /** Consecutive sub-exit ticks required to drift out. */
  exitDwell: number;
  /** An adjacent peer unseen this many ticks clears via the backstop. */
  stalenessTicks: number;
  /** Cap the tracked-peer set; overflow evicts the weakest non-adjacent. */
  maxTrackedPeers: number;
}

/** Deliberate defaults (no runtime self-adaptation — carry D-001). The band
 *  [0.25, 0.55) sits under collision-hysteresis's enter (0.4 is INSIDE the band
 *  on purpose: a pair can be adjacent before P-004's dwell confirms a collision;
 *  the escalation exit hands over cleanly when it does). */
export const DEFAULT_ADJACENCY_PARAMS: AdjacencyParams = {
  enterThreshold: 0.25,
  duplicateThreshold: 0.55,
  enterDwell: 3,
  exitThreshold: 0.15,
  exitDwell: 6,
  stalenessTicks: 4,
  maxTrackedPeers: 16,
};

/** Warn (never throw) on params that would defeat the band / the hysteresis. */
export function validateAdjacencyParams(p: AdjacencyParams): string[] {
  const w: string[] = [];
  if (!(p.enterThreshold < p.duplicateThreshold)) w.push('enterThreshold should be < duplicateThreshold (no adjacency band)');
  if (!(p.exitThreshold <= p.enterThreshold)) w.push('exitThreshold should be ≤ enterThreshold (a hysteresis gap prevents flapping)');
  if (!(p.exitDwell >= p.enterDwell)) w.push('exitDwell should be ≥ enterDwell (asymmetric dwell)');
  if (!(p.stalenessTicks >= 1)) w.push('stalenessTicks should be ≥ 1');
  if (!(p.maxTrackedPeers >= 1)) w.push('maxTrackedPeers should be ≥ 1');
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
// The shared topic name — both sides derive the SAME name, no coordination
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic topic for an adjacent pair, derived from the overlap's shared
 *  terms (already contribution-sorted; the overlap is symmetric so BOTH sessions
 *  compute the identical name): `adj:wi-4790+psu-launcher.mjs+compaction`. */
export function sharedTopicName(sharedTerms: Array<{ term: string }>, maxTerms = 3): string {
  const terms = sharedTerms.slice(0, Math.max(1, maxTerms)).map((t) => t.term.toLowerCase());
  return 'adj:' + (terms.length > 0 ? terms.join('+') : 'unnamed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Notices + the tick
// ─────────────────────────────────────────────────────────────────────────────

export type AdjacencyChangeKind = 'adjacency-entered' | 'adjacency-exited';
export type AdjacencyExitReason = 'drifted' | 'staleness' | 'escalated-to-collision';

export interface AdjacencyNotice {
  kind: AdjacencyChangeKind;
  sessionId: string;
  score: number;
  /** The shared topic both sides should (un)subscribe (P-008 consumes this). */
  topic: string;
  sharedTerms: string[];
  reason: string;
}

export interface AdjacencyTickInput {
  states: AdjacencyState[];
  /** This tick's snapshot — the SAME lexical-cursor collisionCandidates feed
   *  P-004 consumes (peers sharing ≥1 term, scored). */
  snapshot: CollisionLike[];
  tick: number;
  params?: AdjacencyParams;
}

export interface AdjacencyTickResult {
  states: AdjacencyState[];
  /** Entered-first, then by session id — each carries the derived shared topic. */
  notices: AdjacencyNotice[];
}

/**
 * Advance the adjacency machine one tick. Banded hysteresis fold: only overlap
 * in [enter, duplicate) builds the streak; ≥ duplicate while adjacent exits as
 * 'escalated-to-collision' (P-004 takes over); drift + staleness exit like the
 * sibling folds. PURE — the input state is never mutated.
 */
export function adjacencyTick(input: AdjacencyTickInput): AdjacencyTickResult {
  const params = input.params ?? DEFAULT_ADJACENCY_PARAMS;
  const tick = input.tick;

  const snap = new Map<string, CollisionLike>();
  for (const c of input.snapshot) {
    if (c && c.sessionId) snap.set(c.sessionId, c);
  }

  const states = new Map<string, AdjacencyState>();
  for (const s of input.states) states.set(s.sessionId, { ...s, lastSharedTerms: [...(s.lastSharedTerms ?? [])] });
  for (const sid of snap.keys()) {
    if (!states.has(sid)) {
      states.set(sid, {
        sessionId: sid, adjacent: false,
        inBandStreak: 0, belowExitStreak: 0, ticksSinceSeen: 0,
        lastScore: 0, lastSharedTerms: [],
      });
    }
  }

  const notices: AdjacencyNotice[] = [];
  const noticeFor = (kind: AdjacencyChangeKind, s: AdjacencyState, reason: string): AdjacencyNotice => ({
    kind, sessionId: s.sessionId, score: s.lastScore,
    topic: sharedTopicName(s.lastSharedTerms.map((term) => ({ term }))),
    sharedTerms: [...s.lastSharedTerms], reason,
  });

  for (const st of states.values()) {
    const cand = snap.get(st.sessionId);
    const seen = cand !== undefined;
    const score = seen ? cand!.overlap.score : 0;

    st.ticksSinceSeen = seen ? 0 : st.ticksSinceSeen + 1;
    if (seen) {
      st.lastScore = score;
      st.lastSharedTerms = cand!.overlap.sharedTerms.map((t) => t.term);
    }

    const inBand = score >= params.enterThreshold && score < params.duplicateThreshold;
    st.inBandStreak = inBand ? st.inBandStreak + 1 : 0;
    st.belowExitStreak = score < params.exitThreshold ? st.belowExitStreak + 1 : 0;

    if (!st.adjacent) {
      if (st.inBandStreak >= params.enterDwell) {
        st.adjacent = true;
        st.enteredAtTick = tick;
        st.belowExitStreak = 0;
        notices.push(noticeFor('adjacency-entered', st,
          `overlap in [${params.enterThreshold}, ${params.duplicateThreshold}) sustained for ${params.enterDwell} ticks — adjacent lanes, sharing topic`));
      }
    } else if (seen && score >= params.duplicateThreshold) {
      // Escalation: this is duplicate/collision territory now — hand over to P-004.
      st.adjacent = false;
      st.inBandStreak = 0;
      notices.push(noticeFor('adjacency-exited', st,
        `overlap ${score.toFixed(2)} ≥ ${params.duplicateThreshold} (escalated-to-collision — P-004 takes over)`));
    } else if (st.ticksSinceSeen >= params.stalenessTicks) {
      st.adjacent = false;
      st.inBandStreak = 0;
      notices.push(noticeFor('adjacency-exited', st, `peer unseen for ${st.ticksSinceSeen} ticks (staleness backstop)`));
    } else if (st.belowExitStreak >= params.exitDwell) {
      st.adjacent = false;
      st.inBandStreak = 0;
      notices.push(noticeFor('adjacency-exited', st, `overlap < ${params.exitThreshold} for ${params.exitDwell} ticks (drifted)`));
    }
  }

  // GC + bounded set — same idiom as the sibling folds (adjacent is protected).
  for (const [sid, st] of [...states]) {
    if (!st.adjacent && st.inBandStreak === 0 && st.ticksSinceSeen >= params.stalenessTicks) states.delete(sid);
  }
  if (states.size > params.maxTrackedPeers) {
    const evictable = [...states.values()].filter((s) => !s.adjacent)
      .sort((a, b) => a.lastScore - b.lastScore || b.ticksSinceSeen - a.ticksSinceSeen || a.sessionId.localeCompare(b.sessionId));
    let over = states.size - params.maxTrackedPeers;
    for (const s of evictable) {
      if (over <= 0) break;
      states.delete(s.sessionId);
      over -= 1;
    }
  }

  notices.sort((a, b) => {
    const rank = (a.kind === 'adjacency-entered' ? 0 : 1) - (b.kind === 'adjacency-entered' ? 0 : 1);
    return rank || a.sessionId.localeCompare(b.sessionId);
  });

  return { states: [...states.values()], notices };
}

// ─────────────────────────────────────────────────────────────────────────────
// The cross-feed: an on-topic journal note → a bounded one-liner cross-post
// ─────────────────────────────────────────────────────────────────────────────

export interface CrossFeedInput {
  /** The agent's own journal note for this turn (already echo-guarded). */
  note: string;
  /** Whose note it is (stamped sourceSessionId on the push). */
  sessionId: string;
  /** The shared topic (from the adjacency notice). */
  topic: string;
  /** The topic's terms (the shared terms the adjacency was entered on). */
  topicTerms: string[];
  /** One-liner budget (default 120 chars of note excerpt). */
  maxNoteChars?: number;
}

/**
 * Render an ON-TOPIC journal note as the ~1-line cross-post push, or null when
 * the note is off-topic (shares no term with the topic). On-topic = the note's
 * extracted keywords intersect the topic terms; score = matched/topicTerms
 * fraction (deterministic, ∈ (0,1]). matcherKind 'topic-sub' ⇒ info severity —
 * per-class budgets + the P-011 ledger apply downstream like any push. PURE.
 */
export function crossFeedPush(input: CrossFeedInput): PushObject | null {
  const note = (input.note ?? '').replace(/\s+/g, ' ').trim();
  if (!note || input.topicTerms.length === 0) return null;
  const topicSet = new Set(input.topicTerms.map((t) => t.toLowerCase()));
  const matched: string[] = [];
  for (const { term } of extractKeywords(note)) {
    if (topicSet.has(term.toLowerCase())) matched.push(term);
  }
  if (matched.length === 0) return null; // off-topic — never cross-posted

  const maxNote = Math.max(1, input.maxNoteChars ?? 120);
  const excerpt = note.length <= maxNote ? note : note.slice(0, maxNote - 1).trimEnd() + '…';
  return makePush({
    matcherKind: 'topic-sub',
    handle: { kind: 'topic', ref: input.topic, query: matched },
    teaser: `[${input.topic}] ${input.sessionId}: ${excerpt}`,
    score: matched.length / input.topicTerms.length,
    sourceSessionId: input.sessionId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Deferred live seam (DEFAULT-OFF — later phases, behind the host boundary)
// ─────────────────────────────────────────────────────────────────────────────

/** The live leg: real per-tick snapshots, actuating the shared-topic
 *  subscription (P-008's actuator consumes the notices), and posting the
 *  cross-feed one-liners. Nothing here calls it; ships DEFAULT-OFF until the
 *  acceptance drills exist. */
export type AdjacencyFeed = {
  snapshot(): Promise<CollisionLike[]>;
  crossPost(push: PushObject): Promise<void>;
};
