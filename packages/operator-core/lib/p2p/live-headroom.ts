/**
 * p2p/live-headroom.ts — WI-3590: the PHYSICS half of the D-007 claim gate.
 *
 * `host-availability.ts` composes `AxisAvailability { allotmentRemaining, liveHeadroom }`; its
 * POLICY half (P-201 allotment cap − P-205 metered spend) was real from WI-1937, while
 * `liveHeadroom` was hardcoded to 0 for BOTH axes, making `axisAvailable = min(cap, 0) = 0` and
 * every claim refusable-by-construction. This module supplies the missing real-time reads.
 *
 * ## The two axes are NOT symmetric, and that is the whole design problem
 *
 * `AxisAvailability`'s contract (claim-authority.ts) is that BOTH fields are in the axis's budget
 * unit (H14), because the gate takes `min()` of them. That is easy for one axis and impossible to
 * do naively for the other:
 *
 * - **local** — unit is SLOTS. The gateway's local-backend pool reports `maxConcurrent` and live
 *   `inFlight` per backend, so free slots is a direct, unit-correct count (`freeSlots`). No
 *   modelling required.
 *
 * - **remote** — unit is USD-MICROS (`absoluteCapOf` converts `axis.dollarCapUsd × 1e6`). The
 *   gateway does NOT know dollars. It knows rate-limit windows, queue depth, pause state and how
 *   many pool accounts are currently serviceable. There is no account-balance reader anywhere in
 *   this codebase (verified 2026-07-27), and there is no pool-budget source to price a window
 *   against. So "read live balance room" as WI-3590's scope line phrases it is not implementable
 *   as stated — the number it asks for does not exist.
 *
 * ### D-007 PHYSICS for the remote axis = a DERATING of the policy cap, not an independent quantity
 *
 * The resolution that keeps `min()` unit-correct without fabricating dollars: PHYSICS expresses
 * what FRACTION of this host's policy cap is spendable right now, and returns that fraction OF the
 * cap. At utilization 0 the physics layer does not bind (the policy cap governs, which is the
 * intended D-007 behaviour); at utilization 1.0 it is 0 and the claim is refused with
 * `no_live_headroom`. Between, it scales linearly. This never fails OPEN — it can only ever
 * return ≤ `allotmentRemaining` — which is the property the WI-1937 module doc demanded when it
 * chose fail-closed over "fabricate a number that could fail OPEN on a foreign-code-execution
 * gate".
 *
 * It is a MODEL, and it is labelled as one: `reason` states which rule produced the number so a
 * P-004 receipt records why a claim was admitted or refused, rather than an unexplained integer.
 *
 * ### What stays fail-closed (zero), deliberately
 * unreachable gateway · paused · the binding window hard-rejected · wholesale-throttled ·
 * `healthyAccounts === 0` · **utilization unknown**. The last one matters: a reachable gateway
 * that reports no unified window has told us nothing about capacity, and treating "no data" as
 * "no load" is exactly the fail-open this module exists to avoid. It mirrors the precedent
 * `absoluteCapOf` already set for a `sharePct`-only allotment row — an unresolved input
 * contributes 0 rather than a guess.
 *
 * ### Known v1 limitation (documented, not silently papered over)
 * WI-3590 asks for headroom "scoped to the specific pool a fleet was allotted". The gateway's
 * `/stats` is per-GATEWAY (one bound account + pool-wide serviceable count), not per-allotment-row,
 * so this v1 applies a HOST-WIDE remote derating to every fleet this host serves. Per-pool scoping
 * needs a per-pool `/stats` breakdown that does not exist yet; over-sharing capacity between two
 * fleets on one host is bounded by each fleet's own POLICY cap, so the failure mode is contention,
 * never over-spend.
 */
import { freeSlots, type LocalBackendCandidate } from '../inference-gateway/local-backend-pool';
import { isWholesaleThrottled, type GatewayHeadroom, type LocalBackendsSnapshot } from '../inference-gateway/observability';

/** Why a live-headroom number came out the way it did — recorded on P-004 claim receipts so an
 *  admitted or refused claim is explainable after the fact. */
export type HeadroomReason =
  | 'gateway_unreachable'
  | 'gateway_paused'
  | 'window_rejected'
  | 'no_healthy_accounts'
  | 'utilization_unknown'
  | 'derated_by_utilization'
  | 'pool_unreachable'
  | 'pool_not_configured'
  | 'free_slots';

export interface LiveHeadroom {
  /** In the axis's budget unit (usd-micros for remote, slots for local). Never negative. */
  readonly headroom: number;
  readonly reason: HeadroomReason;
  /** Human-readable detail for the receipt/refusal line. */
  readonly detail: string;
}

const zero = (reason: HeadroomReason, detail: string): LiveHeadroom => ({ headroom: 0, reason, detail });

/**
 * PHYSICS for the REMOTE axis, in usd-micros: the share of `allotmentRemaining` that the live
 * gateway state says is spendable right now (see module doc for why this is a derating rather
 * than an independent quantity). Pure — takes an ALREADY-FETCHED headroom read.
 */
export function remoteLiveHeadroom(h: GatewayHeadroom, allotmentRemaining: number): LiveHeadroom {
  if (h.reachable !== true) {
    return zero('gateway_unreachable', `inference gateway unreachable (${h.error ?? 'no /stats'}) — remote capacity unknown, failing closed`);
  }
  // ORDER MATTERS: ask the COMPOSITE predicate first, never `paused`/`rejected` on their own.
  // `isWholesaleThrottled` returns FALSE for a paused-or-rejected gateway that still has
  // priority-tier capacity to fall back on — so short-circuiting on the raw flags would zero out a
  // host that can in fact serve, and would make this branch dead code besides. The raw flags are
  // used only to NAME the reason once the composite has already said "throttled".
  if (isWholesaleThrottled(h)) {
    if (h.paused === true) {
      return zero('gateway_paused', `gateway paused until ${new Date(h.pausedUntil ?? 0).toISOString()} with no tier capacity to fall back on`);
    }
    return zero(
      'window_rejected',
      `binding rate window '${h.window ?? 'unified'}' is hard-rejected (resets in ${h.resetInSec ?? '?'}s) with no tier capacity to fall back on`,
    );
  }
  if (h.healthyAccounts === 0) {
    return zero('no_healthy_accounts', 'pool reports 0 serviceable accounts — every account is walled or paused');
  }
  const u = h.utilization;
  if (typeof u !== 'number' || !Number.isFinite(u)) {
    return zero(
      'utilization_unknown',
      'gateway reachable but reports no unified rate window — no capacity DATA is not the same as no LOAD, so failing closed',
    );
  }
  const spendableFraction = Math.max(0, Math.min(1, 1 - u));
  const cap = Math.max(0, allotmentRemaining);
  // ROUND, not floor: `1 - 0.8` is 0.19999999999999996 in binary floating point, so flooring
  // leaks the residue into the result (199_999 instead of 200_000) — noise that looks like a bug
  // to every later reader. Rounding is still bounded by the cap (the fraction is clamped to
  // [0,1]), so the "PHYSICS can only lower POLICY" invariant is untouched.
  return {
    headroom: Math.round(cap * spendableFraction),
    reason: 'derated_by_utilization',
    detail: `remote window '${h.window ?? 'unified'}' at ${h.utilizationPct ?? Math.round(u * 100)}% — ${Math.round(spendableFraction * 100)}% of the ${cap} usd-micros cap is spendable now`,
  };
}

/**
 * PHYSICS for the LOCAL axis, in slots: free foreign inference slots across the pool RIGHT NOW.
 * Pure — takes an ALREADY-FETCHED pool snapshot.
 *
 * NOTE (M12, claim-authority.ts): host-interactive work always preempts a local slot, so this is
 * an OFFERABLE count, not a reservation — a slot counted free here can be taken by the host's own
 * traffic a moment later. That is by design: D-008 caps rather than reserves, and D-007 re-runs
 * this gate at every reservation.
 */
export function localLiveHeadroom(snap: LocalBackendsSnapshot): LiveHeadroom {
  if (!snap.reachable) {
    return zero('pool_unreachable', `local backend pool unreadable (${snap.error ?? 'gateway down'}) — failing closed`);
  }
  if (!snap.configured) {
    return zero('pool_not_configured', 'gateway runs without a local-backend pool — this host has no local inference capacity');
  }
  const free = freeSlots(snap.candidates as readonly LocalBackendCandidate[]);
  return {
    headroom: free,
    reason: 'free_slots',
    detail: `${free} free slot(s) across ${snap.candidates.filter((c) => c.backend.enabled && c.healthy).length} eligible backend(s)`,
  };
}
