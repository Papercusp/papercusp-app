/**
 * p2p/inference-lease.ts — INFERENCE LEASES: short-lived capacity reservations
 * for burst planning (p2p-work-distribution-2026-07-02 P-203).
 *
 * Item spec (the plan item is the spec, D-016):
 *   Short-lived reservations for burst planning — remote {X tokens for fleet F,
 *   T min} and local {slots + optional model-residency pin}. Auto-expiring;
 *   CLAIM-TIME REVALIDATION STAYS AUTHORITATIVE (leases ADVISE, never replace
 *   the gate).
 * Baked amendments:
 *   H8  — freshness measured against the RECEIVER'S OWN arrival timestamp (never
 *         the sender's stamp); machines advertise a clock offset in presence;
 *         excess skew is FLAGGED (advisory), never a gate.
 *   X6  — arrival-time freshness is ADVISORY only; revocation / dangerous paths
 *         gate on EPOCHS (P-001 grantor high-water), never a wall clock. A lease
 *         whose owner-epoch trails the receiver's high-water is DEAD regardless
 *         of TTL.
 *   H6+X8 — lease-breach receipts feed the HOST RELIABILITY signal EXCEPT
 *         preemption-class interruptions, which are EXCUSED breaches (a distinct
 *         receipt kind) surfaced as an expected-availability signal the scheduler
 *         prices in — a host is NEVER penalized for using its own machine
 *         (D-008's core promise).
 *
 * PURE module (offer-budget.ts / rollout-tiers.ts discipline): no PG, no IO, no
 * clock, no crypto. The two things a real host resolves from the world — the
 * authoritative CLAIM-TIME GATE (P-202 host-gateway: min(allotment, headroom) per
 * axis) and the owner HIGH-WATER epoch (grant-store.ts) — are PASSED IN as
 * already-resolved verdicts. The durable lease STORE and the receipt EMIT are
 * IO edges that live in their own modules (P-205 metering ledger; P-004
 * emitP2pReceipt); this module owns only the lease LIFECYCLE DECISIONS.
 */

import type { BudgetAxis, BudgetUnit } from './offer-budget';

/* ─────────────────────────────────────────────────────────────────────────
 * The lease
 * ───────────────────────────────────────────────────────────────────────── */

export interface InferenceLease {
  readonly leaseId: string;
  readonly fleetSlug: string;
  readonly axis: BudgetAxis;
  /** REMOTE: reserved budget in `unit` (H14 usd-micros/tokens). LOCAL: slot count. */
  readonly amount: number;
  readonly unit: BudgetUnit;
  /** LOCAL only: optionally pin a model resident for the lease window. */
  readonly modelResidencyPin?: string;
  /**
   * H8: the RECEIVER'S OWN arrival timestamp (ms) when it recorded this lease.
   * Expiry is measured from THIS, never a sender stamp — a lying/skewed sender
   * cannot extend its own lease.
   */
  readonly grantedAtReceiver: number;
  /** Auto-expiry window (ms). After grantedAtReceiver + ttlMs the lease is dead. */
  readonly ttlMs: number;
  /** X6: the owner/grantor high-water epoch at grant time (the dangerous-path gate). */
  readonly ownerEpoch: number;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Grant — an OPTIMISTIC advisory reservation (leases advise, never replace)
 * ───────────────────────────────────────────────────────────────────────── */

export interface LeaseGrantRequest {
  readonly leaseId: string;
  readonly fleetSlug: string;
  readonly axis: BudgetAxis;
  readonly amount: number;
  readonly unit: BudgetUnit;
  readonly ttlMs: number;
  readonly ownerEpoch: number;
  readonly modelResidencyPin?: string;
}

export interface LeaseGrantContext {
  /** The RECEIVER's clock (ms) — becomes grantedAtReceiver (H8). */
  readonly nowReceiver: number;
  /**
   * Advisory capacity remaining on this axis after existing active leases:
   * allotment-remaining − Σ(active lease amounts). Leases only ADVISE, so this
   * is a soft planning ceiling; the authoritative gate is re-checked at claim.
   */
  readonly advisoryRemaining: number;
}

export type LeaseGrantResult =
  | { readonly ok: true; readonly lease: InferenceLease }
  | { readonly ok: false; readonly code: 'invalid_amount' | 'invalid_ttl' | 'no_advisory_capacity'; readonly detail: string };

/**
 * Grant a short-lived lease if the axis has advisory capacity. This is a
 * PLANNING reservation, not a commitment — `revalidateAtClaim` re-runs the
 * authoritative gate before any spend. The grant still refuses loudly when the
 * request is malformed or the axis has no advisory headroom (so a caller does
 * not plan a burst it can never claim).
 */
export function grantLease(req: LeaseGrantRequest, ctx: LeaseGrantContext): LeaseGrantResult {
  if (!(Number.isFinite(req.amount) && req.amount > 0)) {
    return { ok: false, code: 'invalid_amount', detail: `lease amount must be finite and > 0 (got ${req.amount})` };
  }
  if (!(Number.isFinite(req.ttlMs) && req.ttlMs > 0)) {
    return { ok: false, code: 'invalid_ttl', detail: `lease ttlMs must be finite and > 0 (got ${req.ttlMs})` };
  }
  if (req.amount > ctx.advisoryRemaining) {
    return {
      ok: false,
      code: 'no_advisory_capacity',
      detail: `lease wants ${req.amount} but only ${ctx.advisoryRemaining} advisory ${req.axis} capacity remains for fleet '${req.fleetSlug}'`,
    };
  }
  return {
    ok: true,
    lease: {
      leaseId: req.leaseId,
      fleetSlug: req.fleetSlug,
      axis: req.axis,
      amount: req.amount,
      unit: req.unit,
      modelResidencyPin: req.modelResidencyPin,
      grantedAtReceiver: ctx.nowReceiver,
      ttlMs: req.ttlMs,
      ownerEpoch: req.ownerEpoch,
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Expiry (H8 receiver clock) + epoch freshness (X6)
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Has the lease auto-expired? Measured against the RECEIVER's clock (H8). A
 * BACKWARDS clock (nowReceiver < grantedAtReceiver) is treated as NOT expired —
 * never expire a lease early on a clock that ran backwards.
 */
export function isLeaseExpired(lease: InferenceLease, nowReceiver: number): boolean {
  const age = nowReceiver - lease.grantedAtReceiver;
  if (age < 0) return false;
  return age > lease.ttlMs;
}

/**
 * X6: is the lease still authorized against the owner's high-water epoch? A
 * lease stamped at an epoch that trails the current high-water is DEAD even if
 * its TTL has not elapsed (a revoked/re-keyed grant). Mirrors grant-store.ts.
 */
export function isLeaseEpochFresh(lease: InferenceLease, ownerHighWaterEpoch: number): boolean {
  return lease.ownerEpoch >= ownerHighWaterEpoch;
}

/* ─────────────────────────────────────────────────────────────────────────
 * H8 clock-skew assessment — ADVISORY ONLY (never gates)
 * ───────────────────────────────────────────────────────────────────────── */

export interface ClockSkewAssessment {
  /** receiverNow − senderStamp (ms). Positive ⇒ the sender's clock trails. */
  readonly skewMs: number;
  /** |skewMs| within the tolerance the presence layer advertises. */
  readonly withinTolerance: boolean;
  /** Excess skew is FLAGGED for surfacing — but it NEVER gates a decision (H8). */
  readonly flagged: boolean;
}

/**
 * Assess the skew between the receiver's own clock and a sender's advertised
 * stamp (H8). This is DIAGNOSTIC: excess skew is flagged so an operator can see
 * a mis-set clock, but it NEVER gates — freshness/expiry always use the
 * receiver's own timestamp, and dangerous paths gate on epochs (X6). A caller
 * must not branch authorization on `flagged`.
 */
export function assessClockSkew(input: { receiverNow: number; senderStamp: number; maxSkewMs: number }): ClockSkewAssessment {
  const skewMs = input.receiverNow - input.senderStamp;
  const withinTolerance = Math.abs(skewMs) <= Math.max(0, input.maxSkewMs);
  return { skewMs, withinTolerance, flagged: !withinTolerance };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Claim-time revalidation — THE authoritative gate (leases advise, never replace)
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * The authoritative claim-time gate verdict, computed by P-202's host-gateway
 * claim authority — min(allotment-remaining, live headroom) > 0 per axis. Passed
 * in so this module stays pure; it is the SOURCE OF TRUTH at claim time.
 */
export interface ClaimGate {
  readonly admits: boolean;
  readonly reason?: string;
}

export type LeaseRevalidation =
  | { readonly ok: true; readonly lease: InferenceLease }
  | {
      readonly ok: false;
      readonly code: 'lease_expired' | 'lease_epoch_stale' | 'gate_refused';
      readonly detail: string;
    };

/**
 * Revalidate a lease at CLAIM time. Leases ADVISE, never replace the gate: a
 * still-valid lease does NOT override a gate that refuses NOW, and an expired /
 * epoch-stale lease is refused before the gate is even consulted.
 *
 * Returns ok:true IFF ALL of: the lease is not expired (receiver clock), its
 * epoch is fresh (X6), AND the authoritative gate admits. This is the load-
 * bearing invariant of the whole lease layer — a lease can never manufacture
 * authorization the gate would deny.
 */
export function revalidateAtClaim(args: {
  lease: InferenceLease;
  gate: ClaimGate;
  nowReceiver: number;
  ownerHighWaterEpoch: number;
}): LeaseRevalidation {
  if (isLeaseExpired(args.lease, args.nowReceiver)) {
    return {
      ok: false,
      code: 'lease_expired',
      detail: `lease ${args.lease.leaseId} expired (granted ${args.lease.grantedAtReceiver} + ttl ${args.lease.ttlMs} < now ${args.nowReceiver}).`,
    };
  }
  if (!isLeaseEpochFresh(args.lease, args.ownerHighWaterEpoch)) {
    return {
      ok: false,
      code: 'lease_epoch_stale',
      detail: `lease ${args.lease.leaseId} epoch ${args.lease.ownerEpoch} trails owner high-water ${args.ownerHighWaterEpoch} (X6) — dead regardless of TTL.`,
    };
  }
  if (!args.gate.admits) {
    return {
      ok: false,
      code: 'gate_refused',
      detail: `authoritative claim gate refuses: ${args.gate.reason ?? 'no capacity'} (leases advise, never replace the gate).`,
    };
  }
  return { ok: true, lease: args.lease };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Lease-breach classification (H6 + X8) — feeds the host reliability signal
 * ───────────────────────────────────────────────────────────────────────── */

export type LeaseBreachCause =
  /** The host's own interactive work preempted the foreign lease (D-008). */
  | 'preemption'
  /** The host reneged on a live lease with no valid reason. */
  | 'host_reneged'
  /** The host crashed/partitioned while holding the lease. */
  | 'host_unreachable'
  /** The axis budget ran out mid-lease. */
  | 'budget_exhausted';

export interface LeaseBreachClassification {
  readonly cause: LeaseBreachCause;
  /**
   * X8 receipt taxonomy: preemption is an EXCUSED breach (a distinct receipt
   * kind), everything else is a plain reliability-denting breach.
   */
  readonly receiptKind: 'excused-breach' | 'reliability-breach';
  /**
   * Does this breach DENT the host's reliability signal? FALSE for preemption
   * (D-008: never penalize a host for using its own machine); TRUE otherwise.
   */
  readonly dentsHostReliability: boolean;
  readonly detail: string;
}

/**
 * Classify a lease breach for the reliability signal (H6/X8). Preemption is the
 * ONLY excused cause — it is surfaced as an expected-availability signal the
 * scheduler prices in, and it must NEVER dent the host's reliability (a host
 * reclaiming its own machine is the whole point of the local axis, D-008).
 */
export function classifyLeaseBreach(cause: LeaseBreachCause): LeaseBreachClassification {
  const excused = cause === 'preemption';
  const detail: Record<LeaseBreachCause, string> = {
    preemption: 'host-interactive preempted the foreign lease — EXCUSED breach, expected-availability signal, no reliability dent (D-008).',
    host_reneged: 'host reneged on a live lease with no valid cause — reliability-denting breach.',
    host_unreachable: 'host became unreachable while holding the lease — reliability-denting breach.',
    budget_exhausted: 'axis budget exhausted mid-lease — reliability-denting breach (the host over-committed).',
  };
  return {
    cause,
    receiptKind: excused ? 'excused-breach' : 'reliability-breach',
    dentsHostReliability: !excused,
    detail: detail[cause],
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Active-lease accounting helper (pure) — the advisory Σ used at grant time
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Sum the amounts of the currently-active (not expired, epoch-fresh) leases on
 * one axis for one fleet — the Σ subtracted from allotment-remaining to get the
 * advisory capacity a new grant checks against. Expired / stale leases are
 * excluded so freed capacity is immediately re-plannable.
 */
export function activeLeasedAmount(
  leases: readonly InferenceLease[],
  filter: { axis: BudgetAxis; fleetSlug?: string; nowReceiver: number; ownerHighWaterEpoch: number },
): number {
  let sum = 0;
  for (const l of leases) {
    if (l.axis !== filter.axis) continue;
    if (filter.fleetSlug != null && l.fleetSlug !== filter.fleetSlug) continue;
    if (isLeaseExpired(l, filter.nowReceiver)) continue;
    if (!isLeaseEpochFresh(l, filter.ownerHighWaterEpoch)) continue;
    sum += l.amount;
  }
  return sum;
}
