/**
 * collision-matcher-io — the LIVE leg of the P-004 collision matcher
 * (ambient-semantic-push-2026-07-14). It stitches the pure sustained-collision
 * fold (collision-hysteresis.ts) to the live cursor index (lexical-cursor.ts +
 * session-cursor-store.ts), the carried-state store (collision-hysteresis-store.ts),
 * and the delivery rail (push-delivery-store.enqueuePush):
 *
 *   read self's fresh cursor + recent LIVE peer cursors  →  buildInvertedIndex  →
 *   collisionCandidates(self)  =  this tick's snapshot  →  collisionHysteresisTick
 *   against the session's CARRIED state  →  save the next state  →  on each ENTER
 *   edge, ENQUEUE a collision push to BOTH sides of the collision.
 *
 * BOTH sides: a sustained collision is symmetric, so when self↔peer converges we
 * enqueue (a) a push to SELF's owner pointing at the PEER session (the enter-edge
 * push the fold already rendered via collisionToPush), and (b) the mirror push to
 * the PEER's owner pointing at SELF. Each side then rides ITS OWN receiver's next
 * wake through the shared rail (prepareAmbientPushBlock → selectPushes → injection
 * door) — this leg only ENQUEUES; the rail selects/tallies/injects at delivery
 * time. The delivery rail IS the notification; there is no separate push here.
 *
 * SEAM: journal:record-turn fires {@link boundedCollisionTick} right AFTER the
 * P-001 cursor upsert (a fresh cursor is the tick trigger). DEFAULT-OFF behind
 * PAPERCUSP_AMBIENT_CURSOR — the caller checks the flag BEFORE importing this
 * module, so the off path never loads it. Bounded + fail-soft (same contract as
 * the cursor build it rides behind): an advisory collision check must never slow
 * or fail the journal write.
 *
 * State is REQUIRED, not an optimization: the hysteresis only ENTERs after the
 * overlap holds for enterDwell CONSECUTIVE ticks, and a tick is one turn-end — so
 * the streak MUST survive across turns (collision-hysteresis-store), which the
 * transcript does not do.
 *
 * DEFERRED-with-reason (live-fleet-gated, not faked here):
 *   • the optional {@link CollisionTickInput.onCollisionEntered} escalation hook
 *     ("notify a fleet leader" on the enter edge) — the enqueue-to-both-sides IS
 *     the primary delivery; a leader escalation is only meaningful against a live
 *     fleet, so it stays an injected best-effort hook, no-op by default.
 *   • precise per-recipient session-CLASS resolution (drone vs interactive) rides
 *     the delivery rail (prepareAmbientPushBlock), not this enqueue leg.
 */
import { withBoundedTimeout } from './bounded-timeout';
import {
  collisionHysteresisTick,
  type CollisionHysteresisParams,
} from './collision-hysteresis';
import {
  buildInvertedIndex,
  collisionCandidates,
  type LexicalCursor,
} from './lexical-cursor';
import { collisionToPush, type CollisionLike, type PushObject } from './ambient-push';

/** Budget for the turn-end collision tick (mirrors CURSOR_BUILD_BUDGET_MS — the
 *  same fire-and-forget turn-end advisory contract). */
export const COLLISION_TICK_BUDGET_MS = 4_000;

/** Only cursors updated within this window are "live" peers for the index. Same
 *  30-min window as the delivery rail's budget/novelty window (a baked default —
 *  belongs on the carry P-023 config surface when the matchers wire up). */
export const PEER_LIVENESS_WINDOW_MS = 30 * 60 * 1000;

/** Cap the live peer cursors pulled into one tick's inverted index. */
export const PEER_SCAN_LIMIT = 100;

/** A legible notice for the optional enter-edge escalation hook (deferred). */
export interface CollisionEnteredNotice {
  selfSessionId: string;
  peerSessionId: string;
  score: number;
  sharedTerms: string[];
}

export interface CollisionTickInput {
  /** The self session whose fresh cursor triggers this tick. */
  selfSessionId: string;
  /** Self's coord identity (the delivery axis for self's own enqueued push). */
  selfOwnerId: string | null;
  /** Clock injection for tests (default Date.now()). */
  nowMs?: number;
  /** Peer liveness window override (default PEER_LIVENESS_WINDOW_MS). */
  peerLivenessMs?: number;
  /** Peer scan cap override (default PEER_SCAN_LIMIT). */
  peerLimit?: number;
  /** Hysteresis params override (default DEFAULT_COLLISION_HYSTERESIS_PARAMS). */
  params?: CollisionHysteresisParams;
  /** DEFERRED escalation hook (live-fleet-gated): called best-effort on each
   *  enter edge. No-op by default; a fault here never breaks the tick. */
  onCollisionEntered?: (notice: CollisionEnteredNotice) => Promise<void> | void;
}

export interface CollisionTickResult {
  /** false when there was no self cursor yet (nothing to tick). */
  ran: boolean;
  /** Peers that JUST entered a sustained collision this tick. */
  entered: number;
  /** Peers that cleared (drifted / vanished) this tick. */
  cleared: number;
  /** Push rows enqueued this tick (both sides of every enter edge). */
  enqueued: number;
  /** The tick counter after this tick. */
  tick: number;
  /** This tick's collisionCandidates snapshot — computed ONCE here and handed
   *  to the P-013 adjacency leg (adjacency-cross-feed-io.ts) so both matchers
   *  ride one peer read + index build. Absent on the no-cursor / timed-out path. */
  snapshot?: CollisionLike[];
  /** owner_id per live peer session in this tick's snapshot (the adjacency
   *  cross-feed's delivery axis). Absent whenever `snapshot` is. */
  ownerBySession?: Map<string, string | null>;
}

const ZERO_RESULT: CollisionTickResult = { ran: false, entered: 0, cleared: 0, enqueued: 0, tick: 0 };

/**
 * Build the MIRROR push for the peer's side of a symmetric collision: the
 * enter-edge push points self→peer (handle.ref = peer); the peer must receive the
 * same collision pointing peer→self. Rebuilt through the SAME collisionToPush
 * bridge (identical teaser/severity/stamp shape) from the shared terms + score
 * the fold already computed. PURE.
 */
export function mirrorCollisionPush(selfSessionId: string, selfToPeer: PushObject): PushObject {
  const like: CollisionLike = {
    sessionId: selfSessionId,
    overlap: {
      score: selfToPeer.score,
      sharedTerms: selfToPeer.handle.query.map((term) => ({ term })),
    },
  };
  return collisionToPush(like);
}

/**
 * Run one collision tick for `selfSessionId`. Reads its just-persisted cursor and
 * the live peer cursors, folds the hysteresis against carried state, persists the
 * next state, and enqueues both sides of every enter-edge collision. Assumes the
 * feature is enabled (the caller gates on PAPERCUSP_AMBIENT_CURSOR before
 * importing this module). Not bounded here — {@link boundedCollisionTick} owns the
 * budget + the fail-soft guarantee.
 */
export async function runCollisionTick(input: CollisionTickInput): Promise<CollisionTickResult> {
  const nowMs = input.nowMs ?? Date.now();
  const livenessMs = input.peerLivenessMs ?? PEER_LIVENESS_WINDOW_MS;
  const limit = input.peerLimit ?? PEER_SCAN_LIMIT;

  const [cursorStore, stateStore, deliveryStore] = await Promise.all([
    import('./session-cursor-store'),
    import('./collision-hysteresis-store'),
    import('./push-delivery-store'),
  ]);

  // Self's freshly-persisted cursor is the tick input. No cursor yet ⇒ nothing to do.
  const selfRow = await cursorStore.getSessionCursorRow(input.selfSessionId);
  if (!selfRow) return { ...ZERO_RESULT, ran: false };
  const selfCursor: LexicalCursor = cursorStore.rowToCursor(selfRow);

  // Recent LIVE peer cursors (excluding self's own session). A peer of the SAME
  // owner is the same person's other session — not a cross-agent convergence, so
  // it is filtered out of the index (only when we know self's owner).
  const peerRows = await cursorStore.recentSessionCursors({
    excludeSessionId: input.selfSessionId,
    updatedSince: new Date(nowMs - livenessMs),
    limit,
  });
  const ownerBySession = new Map<string, string | null>();
  const peerCursors: LexicalCursor[] = [];
  for (const r of peerRows) {
    if (input.selfOwnerId != null && r.owner_id === input.selfOwnerId) continue; // same person
    ownerBySession.set(r.session_id, r.owner_id);
    peerCursors.push(cursorStore.rowToCursor(r));
  }

  // The lookup: which live peers overlap self's cursor right now, and by how much.
  const index = buildInvertedIndex(peerCursors);
  const snapshot = collisionCandidates(index, selfCursor, {
    excludeSessionId: input.selfSessionId,
  });

  // Fold the hysteresis against the carried state, then persist the next state.
  const carry = await stateStore.loadCollisionState(input.selfSessionId);
  const nextTick = carry.tick + 1;
  const result = collisionHysteresisTick({
    states: carry.states,
    snapshot,
    tick: nextTick,
    params: input.params,
  });
  await stateStore.saveCollisionState({
    sessionId: input.selfSessionId,
    ownerId: input.selfOwnerId,
    tick: nextTick,
    states: result.states,
  });

  // Enqueue BOTH sides of every enter-edge collision. Per-push guarded so one bad
  // row never drops the rest; a missing target owner simply skips that side.
  let enqueued = 0;
  for (const push of result.pushes) {
    const peerSessionId = push.handle.ref;
    const peerOwnerId = ownerBySession.get(peerSessionId) ?? null;

    // (a) self's side — the fold's push, pointing at the peer.
    if (input.selfOwnerId) {
      try {
        await deliveryStore.enqueuePush({
          targetOwnerId: input.selfOwnerId,
          targetSessionId: input.selfSessionId,
          matcherKind: 'collision',
          severity: push.severity,
          handleKind: push.handle.kind,
          handleRef: push.handle.ref,
          handleQuery: push.handle.query,
          teaser: push.teaser,
          score: push.score,
          sourceSessionId: push.sourceSessionId ?? null,
        });
        enqueued += 1;
      } catch {
        /* fail-soft: skip this side */
      }
    }

    // (b) peer's side — the mirror push, pointing back at self.
    if (peerOwnerId) {
      const mirror = mirrorCollisionPush(input.selfSessionId, push);
      try {
        await deliveryStore.enqueuePush({
          targetOwnerId: peerOwnerId,
          targetSessionId: peerSessionId,
          matcherKind: 'collision',
          severity: mirror.severity,
          handleKind: mirror.handle.kind,
          handleRef: mirror.handle.ref,
          handleQuery: mirror.handle.query,
          teaser: mirror.teaser,
          score: mirror.score,
          sourceSessionId: mirror.sourceSessionId ?? null,
        });
        enqueued += 1;
      } catch {
        /* fail-soft: skip this side */
      }
    }

    // Optional DEFERRED escalation hook (live-fleet-gated) — best-effort.
    if (input.onCollisionEntered) {
      try {
        await input.onCollisionEntered({
          selfSessionId: input.selfSessionId,
          peerSessionId,
          score: push.score,
          sharedTerms: push.handle.query,
        });
      } catch {
        /* an escalation fault never breaks the tick */
      }
    }
  }

  let entered = 0;
  let cleared = 0;
  for (const n of result.notices) {
    if (n.kind === 'collision-entered') entered += 1;
    else if (n.kind === 'collision-cleared') cleared += 1;
  }

  return { ran: true, entered, cleared, enqueued, tick: nextTick, snapshot, ownerBySession };
}

/**
 * The seam the journal:record-turn hook calls after the cursor upsert: bounded +
 * fail-soft collision tick. Never throws, never hangs past
 * {@link COLLISION_TICK_BUDGET_MS}; degrades to a no-op result. The caller checks
 * {@link import('./session-cursor-io').ambientCursorEnabled} BEFORE importing this
 * module, so the default-off path never loads the collision code.
 */
export async function boundedCollisionTick(input: CollisionTickInput): Promise<CollisionTickResult> {
  const { value } = await withBoundedTimeout(runCollisionTick(input), {
    fallback: ZERO_RESULT,
    timeoutMs: COLLISION_TICK_BUDGET_MS,
    label: 'turn-end-collision-tick',
  });
  return value;
}
