/**
 * p2p/claim-authority.ts — HOST-GATEWAY CLAIM AUTHORITY (D-007)
 * (p2p-work-distribution-2026-07-02 P-202).
 *
 * Item spec (D-016): an offer is CLAIMABLE iff min(allotment-remaining, live
 * headroom) > 0, PER AXIS. Remote headroom = account balance / rate limits
 * (existing gateway logic); local headroom = local gateway capacity snapshot
 * (slots free, model resident, host-interactive) from the local-concurrent-
 * inference deltas. H11 — in-flight reservation envelopes + a max-per-call clamp
 * so one 100k+-token call cannot blow past remaining budget.
 *
 * This is the PRODUCTION counterpart to the D-007 gate the P-306 simulation
 * (./sim/sim-model.ts) encodes as an executable spec — the TWO-LAYER gate:
 *   POLICY (remote allotment cap, P-201) × PHYSICS (live local headroom).
 * The two must agree; the sim proves the invariants (no over-spend, no
 * starvation), this is the function a real host actually calls at claim time.
 *
 * PURE module (offer-budget.ts / rollout-tiers.ts discipline): no PG, no IO, no
 * clock. The host reads its allotment (P-201 listResourceAllotments), subtracts
 * metered spend (P-205), and measures live headroom (remote = existing account
 * logic; local = the inference-delta snapshot, M12 fail-closed to 0 until it
 * lands) — then passes the two resolved NUMBERS per axis to this gate. The gate
 * decides claimability and hands back the EFFECTIVE per-axis cap = min(offer
 * envelope, allotment, headroom), ready to seed a P-107 reservation ledger so
 * H11's max-per-call clamp + in-flight accounting apply on top.
 *
 * D-008 axis semantics (why min of the two layers): the REMOTE axis cap is a
 * SPEND ceiling (caps-not-reservations — oversubscription safe, contention
 * resolves here at claim time); the LOCAL axis is a hard PHYSICAL reservation
 * (a foreign slot is a real core, and host-interactive ALWAYS preempts it).
 * Either way a host may only draw what BOTH its policy cap AND its physical
 * capacity allow right now — hence min(policy, physics).
 */

import {
  BUDGET_AXES,
  createLedger,
  minNullable,
  type AxisCap,
  type BudgetAxis,
  type LedgerState,
  type WorkOffer,
} from './offer-budget';
import type { ResourceKind } from './resource-allotments';

/**
 * P-201 allotment resourceKind → P-107 budget axis. account = remote ($),
 * gpu = local (slots). 'agent_slot' (mig 486, agent-allocation-framework) is
 * DELIBERATELY excluded at the type level: a seat is launch capacity, not a
 * spend axis — a claim-gate caller iterating allotment rows must filter
 * agent_slot rows out before budget math (the compiler enforces it here).
 */
export function axisForResourceKind(kind: Exclude<ResourceKind, 'agent_slot'>): BudgetAxis {
  return kind === 'account' ? 'remote' : 'local';
}

/**
 * The two host-side inputs the claim gate reads for ONE axis (D-007). Both are
 * in the axis's budget unit (H14); a negative value is treated as 0.
 */
export interface AxisAvailability {
  /**
   * POLICY. The host's remaining CAP for this fleet on this axis = the P-201
   * allotment cap minus metered committed+in-flight spend (P-205). A cap, not a
   * reservation (D-008) — oversubscription is safe; contention resolves here.
   */
  allotmentRemaining: number;
  /**
   * PHYSICS. Real-time capacity RIGHT NOW, read live from the inference gateway by
   * `live-headroom.ts` (WI-3590): remote = this host's policy cap derated by the binding rate
   * window's utilization (the gateway reports rate room, not dollars — see that module's doc);
   * local = free foreign slots on the local-backend pool. M12 still holds: host-interactive work
   * always preempts a local slot, so this is an offerable count, not a reservation. Any unknown
   * (gateway down, paused, hard-rejected, no serviceable accounts, no utilization data) resolves
   * to 0 — PHYSICS can only ever lower what POLICY allowed.
   */
  liveHeadroom: number;
  /**
   * Optional human-readable provenance for `liveHeadroom` ("window '5h' at 82% — 18% of the
   * 1000000 usd-micros cap is spendable now"). Surfaced on a `no_live_headroom` refusal so a
   * P-004 receipt records WHY a claim was refused instead of a bare zero. Absent on a caller that
   * builds `AxisAvailability` by hand.
   */
  liveHeadroomDetail?: string;
}

/** What the host can serve for a fleet, per axis. `null` = the host serves no allotment on that axis (M11 default-zero). */
export interface HostAvailability {
  remote: AxisAvailability | null;
  local: AxisAvailability | null;
}

/** D-007 per-axis available = min(POLICY cap-remaining, PHYSICS live headroom), floored at 0. */
export function axisAvailable(a: AxisAvailability): number {
  return Math.max(0, Math.min(a.allotmentRemaining, a.liveHeadroom));
}

export type ClaimAxisRefusalCode =
  | 'axis_not_served' // host has no allotment for this fleet on this axis (M11)
  | 'no_allotment_remaining' // POLICY layer: the cap is exhausted
  | 'no_live_headroom'; // PHYSICS layer: no real-time capacity

export interface ClaimAxisRefusal {
  readonly axis: BudgetAxis;
  readonly code: ClaimAxisRefusalCode;
  readonly available: number;
  readonly detail: string;
}

export interface ClaimAxisGrant {
  readonly axis: BudgetAxis;
  /** min(allotment-remaining, live headroom) — the two-layer available. */
  readonly available: number;
  /** The effective per-axis cap = min(offer envelope, available), to seed a P-107 ledger (H11). */
  readonly effectiveCap: AxisCap;
}

export type ClaimAuthorityResult =
  | { ok: true; claimable: true; grants: ClaimAxisGrant[] }
  | { ok: false; claimable: false; refusals: ClaimAxisRefusal[] };

/**
 * D-007 host-gateway claim authority. An offer is claimable iff EVERY axis its
 * budget envelope draws is admitted by BOTH layers — POLICY (allotment
 * remaining) AND PHYSICS (live headroom) — i.e. min(...) >= minViable (default
 * 1). The host gateway is ALWAYS the authority (never the remote peer): this
 * runs host-side at claim time and is RE-RUN at every reservation (leases
 * advise, the gate decides — P-203).
 *
 * On success each granted axis carries the EFFECTIVE cap = min(offer envelope,
 * available); build a P-107 ledger from it (buildClaimLedgers) so H11's
 * max-per-call clamp + in-flight accounting bound every call. Refusals are
 * per-axis and loud (emit via claimRefusalToReceiptFields → P-004
 * emitP2pReceipt, action 'work-offer:claim'). An offer that draws NO axis
 * (empty envelope) is claimable with no grants — a free, unmetered task.
 */
export function evaluateClaimAuthority(
  offer: WorkOffer,
  host: HostAvailability,
  opts?: { minViable?: Partial<Record<BudgetAxis, number>> },
): ClaimAuthorityResult {
  const grants: ClaimAxisGrant[] = [];
  const refusals: ClaimAxisRefusal[] = [];

  for (const axis of BUDGET_AXES) {
    const want = offer.budget[axis];
    if (want == null) continue; // the offer does not draw this axis
    const avail = host[axis];
    const minViable = opts?.minViable?.[axis] ?? 1;

    if (avail == null) {
      refusals.push({
        axis,
        code: 'axis_not_served',
        available: 0,
        detail: `host serves no ${axis}-axis allotment for fleet '${offer.fleetSlug}' (M11 default-zero — allot the resource first)`,
      });
      continue;
    }

    const allotRem = Math.max(0, avail.allotmentRemaining);
    const headroom = Math.max(0, avail.liveHeadroom);
    const available = Math.min(allotRem, headroom);

    if (available < minViable) {
      // Report the BINDING layer. Policy first when both are short: a cap
      // exhaustion is the more durable refusal (headroom recovers on its own).
      const code: ClaimAxisRefusalCode = allotRem < minViable ? 'no_allotment_remaining' : 'no_live_headroom';
      refusals.push({
        axis,
        code,
        available,
        detail:
          `${axis} axis unavailable [D-007 POLICY×PHYSICS]: allotment-remaining ${allotRem}, live headroom ${headroom} (need >= ${minViable})` +
          (code === 'no_live_headroom' && avail.liveHeadroomDetail ? ` — ${avail.liveHeadroomDetail}` : ''),
      });
      continue;
    }

    grants.push({
      axis,
      available,
      effectiveCap: {
        cap: Math.min(want.cap, available),
        unit: want.unit,
        // one call is bounded by the offer's own H11 clamp AND the effective cap
        maxPerCall: minNullable(want.maxPerCall, Math.min(want.cap, available)),
      },
    });
  }

  if (refusals.length > 0) return { ok: false, claimable: false, refusals };
  return { ok: true, claimable: true, grants };
}

/**
 * Pure mapping from a claim refusal to the P-004 receipt fields — spread into
 * emitP2pReceipt (kind:'refusal', action:'work-offer:claim'). Kept pure (no IO)
 * so the mapping is unit-tested without PG; the caller owns the emit.
 */
export function claimRefusalToReceiptFields(refusal: ClaimAxisRefusal): {
  action: 'work-offer:claim';
  budgetAxis: BudgetAxis;
  refusal: { code: ClaimAxisRefusalCode; detail: string };
} {
  return {
    action: 'work-offer:claim',
    budgetAxis: refusal.axis,
    refusal: { code: refusal.code, detail: refusal.detail },
  };
}

/**
 * H11 composition: turn a granted claim into per-axis P-107 reservation ledgers,
 * each bounded by the effective cap = min(offer envelope, allotment, live
 * headroom). Every model call the host makes reserves against these (P-107
 * reserve/commit), so no call — however large — can blow past the tightest of
 * the three bounds, and the max-per-call clamp caps a single call. Returns a
 * partial map keyed by axis (only the axes the offer draws).
 */
export function buildClaimLedgers(grants: readonly ClaimAxisGrant[]): Partial<Record<BudgetAxis, LedgerState>> {
  const out: Partial<Record<BudgetAxis, LedgerState>> = {};
  for (const g of grants) out[g.axis] = createLedger(g.effectiveCap);
  return out;
}
