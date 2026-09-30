/**
 * p2p/metering-ledger.ts — the durable-SHAPED METERING + CONTRIBUTION LEDGER
 * (p2p-work-distribution-2026-07-02 P-205).
 *
 * Item spec (the plan item is the spec, D-016):
 *   Metering + contribution ledger: per-(host,fleet) spend counters BOTH AXES;
 *   local axis meters GPU-seconds/tokens served (donation visibility; no economy
 *   in v1).
 * Baked:
 *   M22 — reciprocity/contribution is metered per attested USER (CAPPED), never
 *         per device — machines are cheap (machine #2 here is a VM on machine #1),
 *         so crediting a device would let one user inflate reciprocity by spinning
 *         up VMs. Contribution accrues to the attested gh user id and is capped
 *         per user.
 *   PRIVACY — a host advertises ONLY fleet-scoped remainders + active lease grants
 *         to peers, NEVER account totals (balance / grand spend / per-device
 *         breakdown). The advertised view is structurally incapable of carrying an
 *         account total (its type has no such field), and the lease-grant projection
 *         drops every internal lease field.
 *
 * This is a PURE module (offer-budget.ts / rollout-tiers.ts discipline): no PG, no
 * IO, no clock, no crypto, no FLAGS, no store import. It owns the arithmetic of the
 * cross-offer spend ledger + the per-user contribution counter + the privacy
 * projection; every input the host would read from the world (allotments,
 * currently-active leases, the attested user id) is PASSED IN by the caller, so the
 * whole contract stays a property-testable set of pure functions. The durable table
 * that persists a MeteringLedger, and the P-004 receipt emission, live at the IO
 * edges elsewhere. It composes offer-budget.ts (BudgetAxis/BudgetUnit) and
 * inference-lease.ts (InferenceLease) READ-ONLY.
 */

import { BUDGET_AXES, type BudgetAxis, type BudgetUnit } from './offer-budget';
import type { InferenceLease } from './inference-lease';

// ─────────────────────────────────────────────────────────────────────────────
// Counters
// ─────────────────────────────────────────────────────────────────────────────

/** A running counter for one axis, in a single unit. `amount` is finite and >= 0. */
export interface AxisMeter {
  readonly amount: number;
  readonly unit: BudgetUnit;
}

/**
 * The metering ledger. Immutable — every op returns a NEW ledger. Two maps:
 *  - `spend`: committed DRAW per (host, fleet, axis) — what fleet F drew from host H.
 *  - `contribution`: SERVED per (attested user, axis) — the M22 donation counter,
 *    keyed by the attested gh user id (never a device) and clamped per-user.
 * Keys are NUL-separated composites (refs may contain '/', ':').
 */
export interface MeteringLedger {
  readonly spend: Readonly<Record<string, AxisMeter>>;
  readonly contribution: Readonly<Record<string, AxisMeter>>;
}

export function emptyMeteringLedger(): MeteringLedger {
  return { spend: {}, contribution: {} };
}

const SEP = '\x00';
function spendKey(hostRef: string, fleetSlug: string, axis: BudgetAxis): string {
  return `${hostRef}${SEP}${fleetSlug}${SEP}${axis}`;
}
function contribKey(attestedUserId: string, axis: BudgetAxis): string {
  return `${attestedUserId}${SEP}${axis}`;
}

function isFinitePos(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}
function isFiniteNonNeg(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spend (the DRAW side) — per (host, fleet, axis)
// ─────────────────────────────────────────────────────────────────────────────

export type MeterRefusalCode = 'invalid_amount' | 'meter_unit_mismatch';

export type RecordSpendResult =
  | { ok: true; ledger: MeteringLedger; total: number }
  | { ok: false; code: MeterRefusalCode; detail: string };

/**
 * Record a COMMITTED draw: fleet `fleetSlug` spent `amount` (`unit`) on `axis`
 * from host `hostRef`. Accumulates onto the (host,fleet,axis) counter. H14: the
 * unit must match any prior unit on the same counter — a mismatch is refused loud
 * (no cross-unit conversion). Metering records the ACTUAL spend (it does not clamp
 * to an allotment — over-allotment truth is preserved; the advertised remainder
 * floors at 0 separately).
 */
export function recordSpend(
  ledger: MeteringLedger,
  entry: { hostRef: string; fleetSlug: string; axis: BudgetAxis; amount: number; unit: BudgetUnit },
): RecordSpendResult {
  if (!isFinitePos(entry.amount)) {
    return { ok: false, code: 'invalid_amount', detail: `spend amount must be finite and > 0 (got ${entry.amount})` };
  }
  const key = spendKey(entry.hostRef, entry.fleetSlug, entry.axis);
  const prev = ledger.spend[key];
  if (prev && prev.unit !== entry.unit) {
    return {
      ok: false,
      code: 'meter_unit_mismatch',
      detail: `(${entry.hostRef}, ${entry.fleetSlug}, ${entry.axis}) meters '${prev.unit}' but this draw is '${entry.unit}' (H14: units must agree)`,
    };
  }
  const total = (prev?.amount ?? 0) + entry.amount;
  return {
    ok: true,
    total,
    ledger: { ...ledger, spend: { ...ledger.spend, [key]: { amount: total, unit: entry.unit } } },
  };
}

/** Committed spend recorded for one (host, fleet, axis). 0 when never metered. */
export function spentOn(ledger: MeteringLedger, hostRef: string, fleetSlug: string, axis: BudgetAxis): number {
  return ledger.spend[spendKey(hostRef, fleetSlug, axis)]?.amount ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contribution (the DONATION side) — per ATTESTED USER, capped (M22)
// ─────────────────────────────────────────────────────────────────────────────

export type RecordContributionResult =
  | { ok: true; ledger: MeteringLedger; total: number; credited: number; capped: boolean }
  | { ok: false; code: MeterRefusalCode; detail: string };

/**
 * Record SERVED contribution (GPU-seconds / tokens the host served to foreign
 * work) crediting the ATTESTED USER `attestedUserId` (M22 — the gh user id, NEVER
 * a device ref: two machines of the same user share ONE counter, so a user cannot
 * inflate reciprocity by spinning up VMs). The credit is CLAMPED so the per-user
 * counter never exceeds `perUserCap` — excess served work simply does not count
 * toward reciprocity (`credited < amount`, `capped: true`). `perUserCap` null =
 * uncapped (test/host-local use); production passes the M22 cap.
 */
export function recordContribution(
  ledger: MeteringLedger,
  entry: { attestedUserId: string; axis: BudgetAxis; amount: number; unit: BudgetUnit; perUserCap: number | null },
): RecordContributionResult {
  if (!isFinitePos(entry.amount)) {
    return { ok: false, code: 'invalid_amount', detail: `contribution amount must be finite and > 0 (got ${entry.amount})` };
  }
  if (entry.perUserCap != null && !isFiniteNonNeg(entry.perUserCap)) {
    return { ok: false, code: 'invalid_amount', detail: `perUserCap must be finite and >= 0 or null (got ${entry.perUserCap})` };
  }
  const key = contribKey(entry.attestedUserId, entry.axis);
  const prev = ledger.contribution[key];
  if (prev && prev.unit !== entry.unit) {
    return {
      ok: false,
      code: 'meter_unit_mismatch',
      detail: `user ${entry.attestedUserId} ${entry.axis}-contribution meters '${prev.unit}' but this credit is '${entry.unit}' (H14)`,
    };
  }
  const current = prev?.amount ?? 0;
  const headroom = entry.perUserCap == null ? entry.amount : Math.max(0, entry.perUserCap - current);
  const credited = Math.min(entry.amount, headroom);
  const total = current + credited;
  return {
    ok: true,
    total,
    credited,
    capped: credited < entry.amount,
    ledger: { ...ledger, contribution: { ...ledger.contribution, [key]: { amount: total, unit: entry.unit } } },
  };
}

/** Capped contribution served by one attested user on one axis. 0 when none. */
export function contributionOf(ledger: MeteringLedger, attestedUserId: string, axis: BudgetAxis): number {
  return ledger.contribution[contribKey(attestedUserId, axis)]?.amount ?? 0;
}

/** Donation-visibility view: capped served totals per (user, axis), for a set of users. */
export function contributionView(
  ledger: MeteringLedger,
  attestedUserIds: readonly string[],
): { attestedUserId: string; axis: BudgetAxis; served: number; unit: BudgetUnit }[] {
  const out: { attestedUserId: string; axis: BudgetAxis; served: number; unit: BudgetUnit }[] = [];
  for (const attestedUserId of attestedUserIds) {
    for (const axis of BUDGET_AXES) {
      const m = ledger.contribution[contribKey(attestedUserId, axis)];
      if (m) out.push({ attestedUserId, axis, served: m.amount, unit: m.unit });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Privacy projection — advertise ONLY fleet remainders + lease grants
// ─────────────────────────────────────────────────────────────────────────────

/** A per-(fleet,axis) allotment ceiling the host set (P-201 shape, passed in). */
export interface AllotmentView {
  readonly fleetSlug: string;
  readonly axis: BudgetAxis;
  readonly cap: number;
  readonly unit: BudgetUnit;
}

/** A fleet-scoped remaining figure — the ONLY spend-derived number advertised. */
export interface FleetRemainder {
  readonly fleetSlug: string;
  readonly axis: BudgetAxis;
  /** max(0, allotment cap − spent). Floors at 0 (over-allotment truth stays internal). */
  readonly remaining: number;
  readonly unit: BudgetUnit;
}

/** An advertised active lease grant — internal lease fields (clock/ttl/epoch) stripped. */
export interface LeaseGrantAdvert {
  readonly leaseId: string;
  readonly fleetSlug: string;
  readonly axis: BudgetAxis;
  readonly amount: number;
  readonly unit: BudgetUnit;
}

/**
 * The privacy-preserving capacity a host advertises to peers. It carries ONLY
 * per-fleet remainders + active lease grants. It DELIBERATELY has no field for an
 * account balance, a grand total across fleets, a per-device breakdown, or the
 * contribution ledger — the type is structurally incapable of leaking them, so a
 * caller cannot accidentally advertise a total.
 */
export interface AdvertisedCapacity {
  readonly hostRef: string;
  readonly fleetRemainders: readonly FleetRemainder[];
  readonly leaseGrants: readonly LeaseGrantAdvert[];
}

/**
 * Build the advertised capacity for `hostRef`. For each supplied allotment (the
 * host's per-fleet ceilings) the remainder = max(0, cap − spent-for-that-fleet)
 * in the allotment's unit — but ONLY when the ledger's unit for that counter
 * agrees (a mismatched-unit counter is treated as un-comparable → remainder = cap,
 * never a wrong-unit subtraction). Active leases are projected down to the
 * advertised fields only (leaseId/fleet/axis/amount/unit) — grantedAtReceiver,
 * ttlMs and ownerEpoch never cross the wire. `activeLeases` must already be
 * filtered to live/epoch-fresh by the caller (inference-lease.ts owns liveness).
 */
export function buildAdvertisedCapacity(input: {
  hostRef: string;
  ledger: MeteringLedger;
  allotments: readonly AllotmentView[];
  activeLeases: readonly InferenceLease[];
}): AdvertisedCapacity {
  const fleetRemainders: FleetRemainder[] = input.allotments.map((a) => {
    const counter = input.ledger.spend[spendKey(input.hostRef, a.fleetSlug, a.axis)];
    // Only subtract when units agree; otherwise expose the untouched cap (never a wrong-unit figure).
    const spent = counter && counter.unit === a.unit ? counter.amount : 0;
    return { fleetSlug: a.fleetSlug, axis: a.axis, remaining: Math.max(0, a.cap - spent), unit: a.unit };
  });
  const leaseGrants: LeaseGrantAdvert[] = input.activeLeases.map((l) => ({
    leaseId: l.leaseId,
    fleetSlug: l.fleetSlug,
    axis: l.axis,
    amount: l.amount,
    unit: l.unit,
  }));
  return { hostRef: input.hostRef, fleetRemainders, leaseGrants };
}
