/**
 * p2p/model-class-routing.ts — MODEL-CLASS ON OFFERS + the routing decision
 * (p2p-work-distribution-2026-07-02 P-207).
 *
 * Item spec (the plan item is the spec, D-016):
 *   Model-class on offers: {frontier-remote | local-small | any} + latency
 *   tolerance; bulk/background work routes to donated GPUs, frontier reasoning
 *   to remote allotments. Baked: M12 — foreign local slots DEFAULT 0 (fail
 *   closed) until the local-concurrent-inference deltas land.
 *
 * P-107 deliberately left `WorkOffer.modelClass` a free string — THIS module
 * owns the vocabulary. The class constrains WHICH BUDGET AXIS serves the
 * offer's inference (remote = gateway account allotments, local = donated GPU
 * slots); the D-007 claim gate (P-202) then decides whether the routed axis
 * actually has capacity. Routing NEVER grants capacity — it only narrows the
 * envelope the gate evaluates, so every fail-closed property of the gate (M12
 * zero-headroom local, M11 default-zero allotments) applies unchanged.
 *
 * Latency tolerance (the second half of the spec): an offer may carry
 * `latencyToleranceMs` — the slowest indicative first-token latency the
 * requester accepts. Donated GPUs are batch-class (~9 tok/s ornith-tier), so
 * for 'any' offers the tolerance is a HARD gate on the local candidate:
 *   - no tolerance stated (absent/null) ⇒ latency-tolerant bulk ⇒ local is
 *     admissible and PREFERRED (donations absorb bulk, conserving remote $);
 *   - tolerance stated ⇒ local admissible only when the host's indicative
 *     local latency is KNOWN and within it — an UNKNOWN local latency cannot
 *     satisfy a stated bound (fail-closed, the M12 direction).
 * An explicit 'local-small' class is the publisher's own call — latency does
 * not gate it (they chose the donated tier knowingly); 'frontier-remote' never
 * routes local regardless of tolerance.
 *
 * PURE module (offer-budget.ts / claim-authority.ts discipline): no PG, no IO,
 * no clock, no FLAGS. The host reads its capacity snapshot elsewhere and
 * passes the resolved numbers in.
 */

import type { BudgetAxis, BudgetEnvelope, WorkOffer } from './offer-budget';
import {
  evaluateClaimAuthority,
  type ClaimAxisGrant,
  type ClaimAxisRefusal,
  type HostAvailability,
} from './claim-authority';

/** The P-207 model-class vocabulary. */
export const MODEL_CLASSES = ['frontier-remote', 'local-small', 'any'] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

const MODEL_CLASS_SET: ReadonlySet<string> = new Set(MODEL_CLASSES);

/**
 * Parse a wire model-class string. Fail-closed: anything outside the exact
 * vocabulary (unknown word, casing drift, whitespace) is null — callers refuse
 * loudly rather than guessing a route for an unintelligible class.
 */
export function parseModelClass(raw: string): ModelClass | null {
  return MODEL_CLASS_SET.has(raw) ? (raw as ModelClass) : null;
}

/** The offer fields routing reads (a WorkOffer satisfies this). */
export type RoutableOffer = Pick<WorkOffer, 'modelClass' | 'budget'> & {
  readonly latencyToleranceMs?: number | null;
};

/** Host-side signals the route decision needs (from the capacity snapshot). */
export interface HostRouteSignals {
  /**
   * Indicative first-token latency of the host's local (donated-GPU) serving
   * path, ms. `null` = unknown / no local backend measured — fail-closed for
   * latency-bounded offers (an unmeasured path cannot satisfy a stated bound).
   */
  readonly localIndicativeLatencyMs: number | null;
}

export type RouteRefusalCode =
  | 'unknown_model_class' // outside the P-207 vocabulary (fail-closed parse)
  | 'model_class_budget_mismatch' // the class demands an axis the envelope does not draw
  | 'latency_excludes_all_axes'; // the stated tolerance rules out every drawn axis

export interface RouteRefusal {
  readonly code: RouteRefusalCode;
  readonly detail: string;
}

export type RouteDecision =
  | {
      ok: true;
      /**
       * Admissible axes in PREFERENCE order (first = try to claim there first).
       * Empty = the offer draws no axis at all (a free, unmetered task — P-202
       * parity: claimable with no grants).
       */
      axes: readonly BudgetAxis[];
    }
  | { ok: false; refusal: RouteRefusal };

/** Is the local candidate admissible for an 'any' offer, per the latency gate? */
function localPassesLatencyGate(offer: RoutableOffer, signals: HostRouteSignals): boolean {
  const tol = offer.latencyToleranceMs;
  if (tol == null) return true; // no bound stated — latency-tolerant bulk
  if (!(Number.isFinite(tol) && tol >= 0)) return false; // malformed bound — fail closed
  const indicative = signals.localIndicativeLatencyMs;
  if (indicative == null) return false; // unknown local latency cannot satisfy a bound
  return indicative <= tol;
}

/**
 * The P-207 routing decision: which budget axes may serve this offer's
 * inference, in preference order. Pure; capacity is NOT consulted here — the
 * D-007 gate does that (evaluateRoutedClaimAuthority composes the two).
 *
 * A class that names a paid axis ('frontier-remote', 'local-small') REQUIRES
 * the envelope to draw that axis: inference intent without a budget for the
 * axis it runs on would execute outside every H11 ledger — refused as
 * `model_class_budget_mismatch` (fail-closed), never passed through unmetered.
 * Only 'any' with an empty envelope is the P-202 free-task pass-through.
 */
export function decideModelClassRoute(
  offer: RoutableOffer,
  signals: HostRouteSignals,
): RouteDecision {
  const cls = parseModelClass(offer.modelClass);
  if (cls === null) {
    return {
      ok: false,
      refusal: {
        code: 'unknown_model_class',
        detail: `model class '${offer.modelClass}' is outside the P-207 vocabulary [${MODEL_CLASSES.join(', ')}] — refusing rather than guessing a route`,
      },
    };
  }

  const draws = (axis: BudgetAxis): boolean => offer.budget[axis] != null;

  if (cls === 'frontier-remote') {
    if (!draws('remote')) {
      return {
        ok: false,
        refusal: {
          code: 'model_class_budget_mismatch',
          detail:
            "model class 'frontier-remote' requires a remote-axis budget envelope — remote inference without a remote ledger would be unmetered (H11)",
        },
      };
    }
    return { ok: true, axes: ['remote'] };
  }

  if (cls === 'local-small') {
    if (!draws('local')) {
      return {
        ok: false,
        refusal: {
          code: 'model_class_budget_mismatch',
          detail:
            "model class 'local-small' requires a local-axis budget envelope — donated-GPU inference without a local ledger would be unmetered (H11)",
        },
      };
    }
    // Latency never gates an explicit local-small — the publisher chose the
    // donated tier knowingly. M12 capacity fail-close happens at the D-007 gate.
    return { ok: true, axes: ['local'] };
  }

  // 'any' — admissible = drawn axes, local latency-gated, local preferred when
  // admissible (bulk to donated GPUs, conserving remote allotments).
  const axes: BudgetAxis[] = [];
  const localDrawn = draws('local');
  const localAdmissible = localDrawn && localPassesLatencyGate(offer, signals);
  if (localAdmissible) axes.push('local');
  if (draws('remote')) axes.push('remote');

  if (axes.length === 0) {
    if (!localDrawn) return { ok: true, axes: [] }; // draws nothing — free, unmetered task
    return {
      ok: false,
      refusal: {
        code: 'latency_excludes_all_axes',
        detail: `latency tolerance ${offer.latencyToleranceMs}ms excludes the local axis (host indicative local latency: ${
          signals.localIndicativeLatencyMs == null ? 'unknown — fail-closed' : `${signals.localIndicativeLatencyMs}ms`
        }) and the envelope draws no remote axis`,
      },
    };
  }
  return { ok: true, axes };
}

/** Restrict a budget envelope to a single axis (the routed one). */
export function restrictEnvelopeToAxis(budget: BudgetEnvelope, axis: BudgetAxis): BudgetEnvelope {
  return {
    remote: axis === 'remote' ? budget.remote : null,
    local: axis === 'local' ? budget.local : null,
  };
}

export type RoutedClaimResult =
  | {
      ok: true;
      claimable: true;
      /** The axis the inference will run on; null = free unmetered task (no axis drawn). */
      axis: BudgetAxis | null;
      /** D-007 grants for the CHOSEN axis only — seed P-107 ledgers from these. */
      grants: readonly ClaimAxisGrant[];
    }
  | { ok: false; claimable: false; routeRefusal: RouteRefusal }
  | { ok: false; claimable: false; routeRefusal: null; claimRefusals: readonly ClaimAxisRefusal[] };

/**
 * P-207 × P-202 composition: route the offer, then run the D-007 claim gate on
 * each admissible axis IN PREFERENCE ORDER; the first axis both layers admit
 * wins, and the returned grants cover that axis alone (the inference runs on
 * exactly one axis — the un-chosen axis's envelope entry is simply not drawn
 * this run, so no ledger exists for it and nothing can spend it). When every
 * admissible axis is refused by the gate, all per-axis refusals are returned
 * so the caller can emit them (claimRefusalToReceiptFields → P-004).
 */
export function evaluateRoutedClaimAuthority(
  offer: WorkOffer & RoutableOffer,
  host: HostAvailability,
  signals: HostRouteSignals,
  opts?: Parameters<typeof evaluateClaimAuthority>[2],
): RoutedClaimResult {
  const route = decideModelClassRoute(offer, signals);
  if (!route.ok) return { ok: false, claimable: false, routeRefusal: route.refusal };
  if (route.axes.length === 0) return { ok: true, claimable: true, axis: null, grants: [] }; // free task

  const refusals: ClaimAxisRefusal[] = [];
  for (const axis of route.axes) {
    const gated = evaluateClaimAuthority(
      { ...offer, budget: restrictEnvelopeToAxis(offer.budget, axis) },
      host,
      opts,
    );
    if (gated.ok) return { ok: true, claimable: true, axis, grants: gated.grants };
    refusals.push(...gated.refusals);
  }
  return { ok: false, claimable: false, routeRefusal: null, claimRefusals: refusals };
}

/**
 * Pure mapping from a route refusal to the P-004 receipt fields — spread into
 * emitP2pReceipt (kind:'refusal', action:'work-offer:claim'). Class-level, so
 * no budgetAxis; axis-level refusals map via claimRefusalToReceiptFields.
 */
export function routeRefusalToReceiptFields(refusal: RouteRefusal): {
  action: 'work-offer:claim';
  refusal: { code: RouteRefusalCode; detail: string };
} {
  return { action: 'work-offer:claim', refusal: { code: refusal.code, detail: refusal.detail } };
}
