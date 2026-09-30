/**
 * fleet-pool-reservation — the leader's third option under a scarce pool
 * (fleet-lead-instrumentation-audit-2026-08-09 P-024, D-013).
 *
 * P-024: "At `factor 0` with 28 queued, members holding work contend equally with idle members
 * polling for work. A leader should be able to say 'my holders outrank idle pollers' instead of
 * choosing between benching members (losing pickup readiness) and letting them add queue depth."
 *
 * WHY THIS IS NOT A PRIORITY MECHANISM (D-013). Measuring first found that the admission-priority
 * substrate already exists and is live: `priority-admission.ts` implements per-tier caps, a
 * reserved tier-1 floor and a numeric within-band ordering, and `tierOf` already accepts an
 * explicit tier. It merely used to be INERT because almost all traffic arrived untagged and fell
 * to the default band — a tagging gap fixed under WI-4542 (done 2026-08-02, and confirmed live:
 * su traffic now lands in tier 2, not tier 5). Adding a second priority system beside a working
 * one would have been the whole cost of not measuring.
 *
 * The residual that IS missing — priority derived from a member's CLAIM STATE — cannot be
 * delivered from the leader's side, because the priority label is stamped at SPAWN time and a
 * running member's header is fixed for its lifetime. A leader-side lever over a spawn-time header
 * would be a control that silently does nothing. That half is filed, not half-built.
 *
 * WHAT THIS MODULE DOES INSTEAD is answer the item's operative complaint, which on re-reading is
 * not about tiers at all: the leader has TWO options and wants a THIRD. Benching removes an idle
 * member's queue pressure but destroys its pickup readiness; leaving it alone preserves readiness
 * but adds polls to a congested queue. The third option already exists in this system — park the
 * member on the `work-item:claimable` event instead of letting it poll. It stops polling AND
 * re-enters the moment work appears, which is exactly the property benching gives up.
 *
 * TWO INVARIANTS, both guarded by tests:
 *   1. A HOLDER IS NEVER HELD BACK, at any pressure. Recommending against a member that is
 *      advancing work would strand in-flight work to relieve congestion it is not causing — the
 *      P-002 inversion in a new costume.
 *   2. NO SCARCITY ⇒ NO RECOMMENDATION. The policy returns `unaffected` for everyone and says so,
 *      rather than emitting advice that looks actionable whenever a leader happens to look.
 *
 * PURE: no PG / IO / clock.
 */

import type { MemberIdleCause } from './fleet-member-idle-verdict';

/** What the leader should do about one member's contention with the pool. */
export type MemberDisposition =
  /** Holds work and is advancing it — protected, never held back. */
  | 'protect'
  /** An idle poller under real scarcity: park it on `work-item:claimable` instead of polling. */
  | 'hold-back'
  /** Nothing to do: no scarcity, or the member is not contending anyway. */
  | 'unaffected';

export interface MemberReservationInput {
  agentId: string;
  /** The P-023 verdict for this member — the single source of "is it holding / idle / gone". */
  idleCause: MemberIdleCause;
}

export interface MemberReservation {
  agentId: string;
  disposition: MemberDisposition;
  reason: string;
  /** The concrete call, present only for `hold-back`. Never a bench. */
  action?: string;
}

export interface PoolScarcity {
  /** Capacity factor in [0,1]; null = unread. Unread is NOT scarce (fail-safe, never invent one). */
  factor: number | null;
  /** Requests waiting across the pool; null = unread. */
  queueDepth: number | null;
}

export interface ReservationConfig {
  /** `factor` at or below which the pool counts as scarce. */
  scarceFactorAtOrBelow: number;
  /** `queueDepth` at or above which the pool counts as scarce, independent of factor. */
  scarceQueueDepthAtOrAbove: number;
}

export const DEFAULT_RESERVATION_CONFIG: ReservationConfig = {
  // 0.25 is the threshold the capacity advice text already uses to mean "scarce — place
  // top-ranked only" (DEFAULT_CAPACITY_DISPATCH_CONFIG.degradedFactorCap). Reused rather than
  // re-chosen so the two surfaces cannot disagree about what "scarce" means.
  scarceFactorAtOrBelow: 0.25,
  // The queue soft cap at which the capacity factor's queue leg reaches 0, for the same reason.
  scarceQueueDepthAtOrAbove: 24,
};

/** Causes that mean the member is holding work. Held back under NO circumstances. */
const HOLDING: ReadonlySet<MemberIdleCause> = new Set<MemberIdleCause>(['working', 'stalled-holder']);

/**
 * Causes that mean the member is not contending for the pool at all, so holding it back would
 * be a no-op dressed up as an action. A member already throttled, ending, or unable to wake is
 * not polling.
 */
const NOT_CONTENDING: ReadonlySet<MemberIdleCause> = new Set<MemberIdleCause>([
  'throttled',
  'session-ending',
  'no-self-wake',
  'parked-awaiting-event',
  'context-exhausted',
  'fleet-blocked',
]);

export interface PoolScarcityVerdict {
  scarce: boolean;
  /** Why — including, when unread, that it is unread rather than healthy. */
  reason: string;
  /** True when the scarcity signal could not be read at all. Never rounded to "not scarce". */
  unread: boolean;
}

/**
 * Is the pool scarce enough to justify holding pollers back?
 *
 * FAIL-SAFE DIRECTION: an UNREAD signal is not scarce. The action gated behind this reduces the
 * fleet's pickup readiness, so an unreadable substrate must not be able to trigger it — but the
 * verdict says `unread: true` rather than reporting a confident "healthy", so a leader can tell
 * "measured fine" from "could not measure" (the same rule as D-011's per-axis availability).
 */
export function assessPoolScarcity(
  pool: PoolScarcity,
  config: ReservationConfig = DEFAULT_RESERVATION_CONFIG,
): PoolScarcityVerdict {
  const { factor, queueDepth } = pool;
  if (factor == null && queueDepth == null) {
    return {
      scarce: false,
      unread: true,
      reason:
        'Pool capacity is UNREAD — not measured healthy. No reservation is recommended, because ' +
        'holding members back costs pickup readiness and must never fire on an unread signal.',
    };
  }
  const byFactor = factor != null && factor <= config.scarceFactorAtOrBelow;
  const byQueue = queueDepth != null && queueDepth >= config.scarceQueueDepthAtOrAbove;
  if (!byFactor && !byQueue) {
    return {
      scarce: false,
      unread: false,
      reason:
        `Pool is not scarce (factor ${factor ?? 'unread'}, queueDepth ${queueDepth ?? 'unread'}). ` +
        'Idle members polling cost nothing worth reclaiming.',
    };
  }
  const legs = [
    byFactor ? `factor ${factor} <= ${config.scarceFactorAtOrBelow}` : null,
    byQueue ? `queueDepth ${queueDepth} >= ${config.scarceQueueDepthAtOrAbove}` : null,
  ].filter(Boolean);
  return { scarce: true, unread: false, reason: `Pool is scarce (${legs.join('; ')}).` };
}

export interface PoolReservationPlan {
  scarcity: PoolScarcityVerdict;
  members: MemberReservation[];
  /** Counts by disposition. A disposition that never fired is ABSENT, not 0. */
  counts: Partial<Record<MemberDisposition, number>>;
  /** The one-line answer a leader reads. */
  summary: string;
}

/**
 * Recommend a reservation plan: who to protect, who to park, and — when the pool is fine —
 * explicitly nobody.
 *
 * The recommended action for a held-back member is `events:await { event: 'work-item:claimable' }`,
 * NEVER `fleet:bench`. That distinction is the entire point of the item: benching removes the
 * queue pressure and the pickup readiness together, and P-024 exists because the leader was
 * forced to trade one for the other.
 */
export function computePoolReservation(
  members: readonly MemberReservationInput[],
  pool: PoolScarcity,
  config: ReservationConfig = DEFAULT_RESERVATION_CONFIG,
): PoolReservationPlan {
  const scarcity = assessPoolScarcity(pool, config);

  const rows: MemberReservation[] = members.map((m) => {
    if (HOLDING.has(m.idleCause)) {
      return {
        agentId: m.agentId,
        disposition: 'protect' as const,
        reason:
          `Holding work (${m.idleCause}) — protected. A holder is never held back: it is not the ` +
          'source of the congestion, and stalling it would strand in-flight work.',
      };
    }
    if (!scarcity.scarce) {
      return { agentId: m.agentId, disposition: 'unaffected' as const, reason: scarcity.reason };
    }
    if (NOT_CONTENDING.has(m.idleCause)) {
      return {
        agentId: m.agentId,
        disposition: 'unaffected' as const,
        reason: `Not contending for the pool (${m.idleCause}) — holding it back would change nothing.`,
      };
    }
    return {
      agentId: m.agentId,
      disposition: 'hold-back' as const,
      reason:
        'Idle and polling while the pool is scarce — its polls add queue depth behind members ' +
        'holding real work.',
      action:
        "events:await { event: 'work-item:claimable' } — parks it WITHOUT losing pickup readiness. " +
        'Do NOT fleet:bench: that sheds the polling and the readiness together, which is the ' +
        'trade this exists to avoid.',
    };
  });

  const counts: Partial<Record<MemberDisposition, number>> = {};
  for (const r of rows) counts[r.disposition] = (counts[r.disposition] ?? 0) + 1;

  const held = counts['hold-back'] ?? 0;
  const summary = !scarcity.scarce
    ? `${scarcity.reason} No reservation recommended.`
    : held === 0
      ? `${scarcity.reason} No idle pollers to hold back — every member is holding work or already not contending.`
      : `${scarcity.reason} Park ${held} idle poller(s) on work-item:claimable; ${counts.protect ?? 0} holder(s) protected.`;

  return { scarcity, members: rows, counts, summary };
}
