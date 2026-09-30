/**
 * p2p/fleet-capacity.ts — the owner-side FLEET CAPACITY VIEW
 * (p2p-work-distribution-2026-07-02 P-206).
 *
 * Item spec (the plan item is the spec, D-016):
 *   Fleet capacity view: the owner-side assigner queries the AGGREGATE of member
 *   hosts' advertised {slots, allotment-remaining per axis, active leases}.
 *   ADVISORY; the pull (host-gateway claim authority, P-202) remains authoritative.
 * Baked:
 *   m13 — a fleet-HEALTH view (offers pending / claimed / stalled) so STRANDED work
 *         is globally visible (a stalled offer nobody drained shows up fleet-wide).
 *   M14 — capacity ads ride the P-006 FLEET SCOPE to opted-in members only, never
 *         hive-broadcast (a hive-wide broadcast leaks who-works-with-whom + idle
 *         patterns). This module aggregates the ads the caller already gathered over
 *         the fleet scope; the scoping itself is the transport's job (P-006). What
 *         this module guarantees is that the aggregate, like each input ad, carries
 *         ONLY fleet-scoped figures — never an account total (it composes
 *         metering-ledger's AdvertisedCapacity, whose type structurally cannot hold
 *         one).
 *
 * PURE module (metering-ledger.ts / offer-budget.ts discipline): no PG, no IO, no
 * clock. The member ads (already privacy-projected + fleet-scoped by the sender)
 * are PASSED IN; this module only does the aggregation arithmetic, so it stays a
 * property-testable pure function. It composes metering-ledger.ts (AdvertisedCapacity,
 * FleetRemainder, LeaseGrantAdvert) READ-ONLY.
 *
 * ADVISORY, NOT AUTHORITATIVE: this view helps an owner-side assigner DECIDE where
 * to place an offer; it never grants anything. A host re-validates at claim (P-202
 * claim authority / P-203 revalidateAtClaim) — a capacity ad can be stale, so the
 * pull is always the source of truth.
 */

import { BUDGET_AXES, type BudgetAxis, type BudgetUnit } from './offer-budget';
import type { AdvertisedCapacity } from './metering-ledger';

/** m13 per-host offer-health counters (advisory; a snapshot the host advertises). */
export interface MemberHealth {
  readonly offersPending: number;
  readonly offersClaimed: number;
  readonly offersStalled: number;
}

const ZERO_HEALTH: MemberHealth = { offersPending: 0, offersClaimed: 0, offersStalled: 0 };

/** One member host's capacity report: its advertised ad + free slots + m13 health. */
export interface MemberCapacityReport {
  /** The privacy-projected advertised capacity (metering-ledger buildAdvertisedCapacity). */
  readonly advertised: AdvertisedCapacity;
  /** Local inference slots currently free (advisory). Defaults 0 when absent. */
  readonly slotsFree?: number;
  /** m13 fleet-health counters this host contributes. Defaults all-zero. */
  readonly health?: MemberHealth;
}

/** An aggregate quantity for one (axis, unit) — units never cross-sum (H14). */
export interface AxisAmount {
  readonly axis: BudgetAxis;
  readonly unit: BudgetUnit;
  readonly amount: number;
}

/** Per-member drill-down row (so a stranded/idle host is individually visible). */
export interface MemberCapacityRow {
  readonly hostRef: string;
  readonly slotsFree: number;
  readonly remainingByAxis: readonly AxisAmount[];
  readonly leaseCount: number;
  readonly health: MemberHealth;
}

/**
 * The aggregated fleet capacity view for ONE fleet. Carries only fleet-scoped
 * sums (remaining / leases / slots / health) + a per-member drill-down — never an
 * account total (structurally, it never had one to leak).
 */
export interface FleetCapacityView {
  readonly fleetSlug: string;
  readonly memberCount: number;
  /** Σ remaining allotment across members, per (axis, unit). */
  readonly remainingByAxis: readonly AxisAmount[];
  /** Σ active lease amount across members, per (axis, unit). */
  readonly activeLeasedByAxis: readonly AxisAmount[];
  readonly activeLeaseCount: number;
  readonly totalSlotsFree: number;
  /** m13: Σ offer-health across members — stranded (stalled) work is globally visible. */
  readonly health: MemberHealth;
  /**
   * Axes where members disagreed on the unit (H14) — their amounts are kept in
   * SEPARATE per-unit entries above, never cross-summed. Empty = all agreed.
   */
  readonly unitConflicts: readonly BudgetAxis[];
  readonly perMember: readonly MemberCapacityRow[];
}

/** Accumulate `amount` under (axis,unit); track which axes saw >1 unit. */
function makeAxisSummer() {
  const byKey = new Map<string, AxisAmount>();
  const unitsPerAxis = new Map<BudgetAxis, Set<BudgetUnit>>();
  return {
    add(axis: BudgetAxis, unit: BudgetUnit, amount: number) {
      if (!(Number.isFinite(amount) && amount > 0)) return;
      const key = `${axis} ${unit}`;
      const prev = byKey.get(key);
      byKey.set(key, { axis, unit, amount: (prev?.amount ?? 0) + amount });
      let units = unitsPerAxis.get(axis);
      if (!units) unitsPerAxis.set(axis, (units = new Set()));
      units.add(unit);
    },
    entries(): AxisAmount[] {
      // Deterministic order: axis order, then unit alphabetical.
      return [...byKey.values()].sort((a, b) => BUDGET_AXES.indexOf(a.axis) - BUDGET_AXES.indexOf(b.axis) || a.unit.localeCompare(b.unit));
    },
    conflicts(): BudgetAxis[] {
      return BUDGET_AXES.filter((ax) => (unitsPerAxis.get(ax)?.size ?? 0) > 1);
    },
  };
}

function sumHealth(a: MemberHealth, b: MemberHealth): MemberHealth {
  return {
    offersPending: a.offersPending + b.offersPending,
    offersClaimed: a.offersClaimed + b.offersClaimed,
    offersStalled: a.offersStalled + b.offersStalled,
  };
}

/**
 * Aggregate member hosts' advertised capacity into the fleet view for `fleetSlug`.
 * Sums remaining allotment (per axis+unit), active leases (per axis+unit), free
 * slots, and m13 health — scoped STRICTLY to `fleetSlug` (a member's other fleets'
 * remainders/leases are ignored, never leaked into this fleet's view). Units never
 * cross-sum (H14): a same-axis unit disagreement across members is kept per-unit and
 * flagged in `unitConflicts`. Advisory only — the pull re-validates at claim.
 */
export function aggregateFleetCapacity(fleetSlug: string, members: readonly MemberCapacityReport[]): FleetCapacityView {
  const remaining = makeAxisSummer();
  const leased = makeAxisSummer();
  let activeLeaseCount = 0;
  let totalSlotsFree = 0;
  let health: MemberHealth = ZERO_HEALTH;
  const perMember: MemberCapacityRow[] = [];

  for (const m of members) {
    const memberRemaining = makeAxisSummer();
    let memberLeaseCount = 0;

    for (const r of m.advertised.fleetRemainders) {
      if (r.fleetSlug !== fleetSlug) continue; // scope: this fleet only
      remaining.add(r.axis, r.unit, r.remaining);
      memberRemaining.add(r.axis, r.unit, r.remaining);
    }
    for (const g of m.advertised.leaseGrants) {
      if (g.fleetSlug !== fleetSlug) continue;
      leased.add(g.axis, g.unit, g.amount);
      memberLeaseCount += 1;
      activeLeaseCount += 1;
    }

    const slots = Number.isFinite(m.slotsFree) && (m.slotsFree ?? 0) > 0 ? (m.slotsFree as number) : 0;
    totalSlotsFree += slots;
    const mh = m.health ?? ZERO_HEALTH;
    health = sumHealth(health, mh);

    perMember.push({
      hostRef: m.advertised.hostRef,
      slotsFree: slots,
      remainingByAxis: memberRemaining.entries(),
      leaseCount: memberLeaseCount,
      health: mh,
    });
  }

  return {
    fleetSlug,
    memberCount: members.length,
    remainingByAxis: remaining.entries(),
    activeLeasedByAxis: leased.entries(),
    activeLeaseCount,
    totalSlotsFree,
    health,
    unitConflicts: [...new Set([...remaining.conflicts(), ...leased.conflicts()])],
    perMember,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Advisory scheduling hints (pure reads over the view)
// ─────────────────────────────────────────────────────────────────────────────

/** m13: is there STRANDED work (any stalled offer) anywhere in the fleet? */
export function hasStrandedWork(view: FleetCapacityView): boolean {
  return view.health.offersStalled > 0;
}

/** Does the fleet advertise ANY remaining headroom on `axis` (advisory)? */
export function fleetHasHeadroom(view: FleetCapacityView, axis: BudgetAxis): boolean {
  return view.remainingByAxis.some((e) => e.axis === axis && e.amount > 0);
}

/**
 * Rank members as advisory placement candidates for `axis`: most remaining
 * headroom first, then most free slots, then hostRef for a stable order. Members
 * with zero headroom on the axis are dropped (nothing to place there).
 */
export function rankPlacementCandidates(view: FleetCapacityView, axis: BudgetAxis): MemberCapacityRow[] {
  const headroomOf = (row: MemberCapacityRow) => row.remainingByAxis.filter((e) => e.axis === axis).reduce((s, e) => s + e.amount, 0);
  return view.perMember
    .filter((row) => headroomOf(row) > 0)
    .sort((a, b) => headroomOf(b) - headroomOf(a) || b.slotsFree - a.slotsFree || a.hostRef.localeCompare(b.hostRef));
}
