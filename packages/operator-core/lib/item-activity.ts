/**
 * item-activity.ts — classify a work-item's TRUE activity from (claim +
 * holder-liveness + progress), as a DEPENDENCY-FREE leaf.
 *
 * agent-activity-liveness-truth-2026-06-21 · P-001 (D-001/D-004). The incident:
 * a green-gate-fix bee DIED seconds after being spawned, yet every reader (the
 * Queen's placement, idle su agents, the coordinator) treated the surviving
 * "bee spawned for X" claim/broadcast as "actively worked" for ~1 hour, so the
 * gate sat RED + unowned and blocked all deploys. Root cause: a CLAIM is a
 * RESERVATION and a presence HEARTBEAT proves the PROCESS is alive — neither
 * proves the WORK is advancing.
 *
 * This is the single canonical derivation every reader should use instead of
 * trusting a claim or a stale broadcast. It is PURE (no I/O): the caller passes
 * the claim fields + a holder-liveness verdict + a clock, and gets one label.
 * `holderAlive` is the caller's liveness verdict for the claim's holder (e.g.
 * from {@link ./liveness}.deriveLiveness over the presence heartbeat); `null` =
 * UNKNOWN (no presence record), never assumed dead.
 *
 * Like {@link ./liveness}, this is server+client safe (imports nothing but the
 * shared STALE_MS window) so the presence UI and the server reconciler share one
 * definition and can't drift.
 */
import { STALE_MS } from './liveness';

/**
 * The single-label activity verdict for a claimed (or unclaimed) item.
 * Priority-ordered (the function returns the first that applies):
 *
 *   • free        — unclaimed (no holder).
 *   • dead        — claimed, but the holder is confirmed NOT alive → reclaimable
 *                   IMMEDIATELY (the incident case: the bee died, the claim
 *                   outlived it). Spawn-death should free this without waiting
 *                   out the lease.
 *   • stalled     — claimed, but no item-scoped PROGRESS within the window
 *                   (holder alive or liveness unknown) → reclaimable. "Claimed
 *                   by a live agent" is not "the work is advancing."
 *   • progressing — claimed, holder ALIVE, and real item-scoped progress within
 *                   the window. This — and ONLY this — is "actively worked."
 *   • alive       — claimed, holder ALIVE, claimed recently, but no item-scoped
 *                   progress recorded YET (the grace window after a fresh claim).
 *   • reserved    — claimed recently, holder liveness UNKNOWN (no presence
 *                   record). A bare reservation we can't yet confirm.
 */
export type ItemActivity = 'free' | 'reserved' | 'alive' | 'progressing' | 'stalled' | 'dead';

/** A timestamp the classifier accepts: epoch ms, ISO string, Date, or null. */
export type ActivityTs = number | string | Date | null | undefined;

export interface ItemActivityInput {
  /** The claim holder (feature → taken_by). Falsy ⇒ unclaimed. */
  takenBy: string | null | undefined;
  /** When the item was claimed — the implicit first "progress" (grace anchor). */
  takenAt: ActivityTs;
  /** Last REAL item-scoped progress (a state transition / checkpoint), or null. */
  lastProgressAt: ActivityTs;
  /**
   * The caller's liveness verdict for the holder: `true` = heartbeating,
   * `false` = confirmed gone, `null`/`undefined` = UNKNOWN (no presence record).
   * Never assume `false` — unknown is its own state (`reserved`).
   */
  holderAlive: boolean | null | undefined;
}

export interface ItemActivityClock {
  /** Now, epoch ms. */
  now: number;
  /** Progress staleness window. Defaults to the shared STALE_MS (10 min). */
  staleMs?: number;
}

function toMs(v: ActivityTs): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Derive an item's true activity from its claim, the holder's liveness, and its
 * last real progress. See {@link ItemActivity} for the label semantics.
 */
export function classifyItemActivity(item: ItemActivityInput, clock: ItemActivityClock): ItemActivity {
  if (!item.takenBy) return 'free';
  // A confirmed-dead holder is reclaimable immediately, regardless of how recent
  // its last progress looked — the work cannot be advancing if the process is gone.
  if (item.holderAlive === false) return 'dead';

  const staleMs = clock.staleMs ?? STALE_MS;
  const lastProgress = toMs(item.lastProgressAt);
  const takenAt = toMs(item.takenAt);
  // The claim time is the implicit first progress: a freshly-claimed item gets a
  // grace window before it can read as "stalled". A claimed row with neither
  // signal (shouldn't happen — taken_at is stamped on claim) fails safe to stalled.
  const ref = lastProgress ?? takenAt;
  const age = ref == null ? Infinity : clock.now - ref;

  if (age > staleMs) return 'stalled';
  // Within the progress window:
  if (lastProgress != null && item.holderAlive === true) return 'progressing';
  if (item.holderAlive === true) return 'alive';
  return 'reserved';
}

/** "Actively worked" ≡ a live holder making progress (D-001). Nothing else counts. */
export function isActivelyWorked(activity: ItemActivity): boolean {
  return activity === 'progressing';
}

/** A claim that should be auto-freed + re-surfaced: the holder is gone, or alive-but-stalled. */
export function isReclaimable(activity: ItemActivity): boolean {
  return activity === 'dead' || activity === 'stalled';
}
