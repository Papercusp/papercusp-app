/**
 * p2p/offer-budget.ts — the WORK-OFFER BUDGET ENVELOPE + host-side budget
 * accounting (p2p-work-distribution-2026-07-02 P-107).
 *
 * Item spec (the plan item is the spec, D-016):
 *   Budget envelope: every offer carries {budget envelope, billed-to,
 *   model-class, isolation reqs, priority}; host clamps to local caps (LOCAL
 *   ALWAYS WINS); exhaustion = graceful wind-down + loud receipt.
 * Baked amendments:
 *   H12 — per-offer CANCELLATION: cancel propagates via coord wake AND the
 *         executor periodically revalidates offer liveness against a TTL,
 *         DEFAULTING TO WIND-DOWN when unconfirmable (partitions).
 *   H11 — per-call reservation envelopes counted IN-FLIGHT against the allotment
 *         + a MAX-PER-CALL clamp so one 100k+-token call cannot blow past
 *         remaining budget.
 *   H16 — publisher rate caps + unclaimed-offer TTLs enforced HOST-SIDE too.
 *
 * This is a PURE module (rollout-tiers.ts discipline): no PG, no IO, no clock,
 * no crypto, and it never imports FLAGS or the allotment store. Every input the
 * host would read from the world — the local caps (P-201 allotments), the
 * current time, the reservation ids — is PASSED IN by the caller, so the whole
 * budget contract stays a property-testable set of pure functions. The two IO
 * edges live elsewhere: the loud wind-down RECEIPT is emitted by
 * ./offer-budget-receipts (P-004 emitP2pReceipt), and the durable spend LEDGER
 * across offers is P-205's metering table — this module owns the in-flight
 * reservation arithmetic + the clamp/liveness/expiry DECISIONS, nothing durable.
 *
 * TWO AXES (mirrors mig 473 resource_allotments): 'remote' = a gateway account
 * pool ($ / model-class), 'local' = local inference (slots / slot-seconds). The
 * accounting is unit-AGNOSTIC — it compares plain numbers in the SAME unit on
 * both sides; the unit tag rides through only to receipts + display. H14: the
 * remote axis is normalised to DOLLARS (usd-micros), never a raw token count
 * (100k Haiku != 100k Fable is an ambiguous contract), so a remote clamp that
 * finds mismatched units REFUSES loudly rather than comparing apples to Fables.
 */

export type BudgetAxis = 'remote' | 'local';
export const BUDGET_AXES: readonly BudgetAxis[] = ['remote', 'local'] as const;

/**
 * The unit an axis cap is denominated in. Accounting never converts between
 * units — both sides of every comparison must already agree (H14). The tag is
 * carried for the receipt / display layer only.
 */
export type BudgetUnit = 'usd-micros' | 'tokens' | 'slot-seconds' | 'slots';

/** One axis's ceiling: the cap + the H11 max-per-call clamp. */
export interface AxisCap {
  /** The ceiling for this axis, in `unit`. Finite and >= 0. */
  readonly cap: number;
  readonly unit: BudgetUnit;
  /**
   * H11: no single reservation may exceed this. `null` = no per-call clamp.
   * When set it is finite and > 0.
   */
  readonly maxPerCall: number | null;
}

/**
 * The two-axis budget envelope. `null` on an axis = "this offer / host does not
 * touch that axis". The offer carries what it WANTS; the host carries what it
 * has ALLOTTED (M11: absence = zero); the clamp intersects them.
 */
export interface BudgetEnvelope {
  readonly remote: AxisCap | null;
  readonly local: AxisCap | null;
}

/** The full work-offer envelope published to a fleet and pulled by a host. */
export interface WorkOffer {
  readonly offerId: string;
  readonly fleetSlug: string;
  /** Publisher (device/user) ref that stamped the offer — P-102 authorship chain. */
  readonly publisherRef: string;
  /** Who pays (D-009 billing matrix) — a pool-id or host ref; routing/display here. */
  readonly billedTo: string;
  /** P-207 model-class hint; a free string here (./model-class-routing owns the vocabulary + routing). */
  readonly modelClass: string;
  /**
   * P-207: the slowest indicative first-token latency (ms) the requester
   * accepts. Absent/null = latency-tolerant bulk (donated-GPU eligible).
   */
  readonly latencyToleranceMs?: number | null;
  /** Higher = more urgent; the scheduler claims higher-priority offers first. */
  readonly priority: number;
  /** Isolation capabilities the host must satisfy to launch this (C5). */
  readonly isolationReqs: readonly string[];
  /**
   * C5: min host runtime version. A host below it REFUSES loudly rather than
   * launching UNCLAMPED (the live stale-VM-bundle precedent). Optional.
   */
  readonly minRuntimeVersion?: string;
  readonly budget: BudgetEnvelope;
  /** ms epoch when the offer was published (H8: receiver-arrival clock for TTL). */
  readonly publishedAt: number;
  /** H16: unclaimed-offer TTL (ms). After publishedAt+ttlMs an unclaimed offer expires. */
  readonly ttlMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small numeric helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** min where `null` means "no constraint" (+∞): returns the TIGHTER of the two. */
export function minNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function isFiniteNonNeg(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/** Validate an AxisCap has sane, finite, non-negative numbers. */
export function isValidAxisCap(c: AxisCap): boolean {
  if (!isFiniteNonNeg(c.cap)) return false;
  if (c.maxPerCall != null && !(Number.isFinite(c.maxPerCall) && c.maxPerCall > 0)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clamp — LOCAL ALWAYS WINS
// ─────────────────────────────────────────────────────────────────────────────

export interface AxisClampNote {
  readonly axis: BudgetAxis;
  readonly effective: AxisCap;
  /** the offer asked for more cap than the host allotted (host cap was the binding ceiling). */
  readonly capReduced: boolean;
  /** the host's max-per-call clamp was tighter than (or added to) the offer's. */
  readonly maxPerCallTightened: boolean;
}

export type ClampRefusalCode =
  | 'budget_axis_unavailable'
  | 'budget_unit_mismatch'
  | 'invalid_axis_cap';

export type ClampOutcome =
  | { ok: true; clamped: BudgetEnvelope; notes: AxisClampNote[] }
  | { ok: false; code: ClampRefusalCode; axis: BudgetAxis; detail: string };

/**
 * Clamp ONE axis to the host's local cap. LOCAL WINS: the effective ceiling is
 * min(offer, local); the effective max-per-call is the tighter of the two. The
 * effective UNIT is the host's (they must already agree — mismatch is refused by
 * the envelope-level clamp before this runs).
 */
export function clampAxisToLocal(offer: AxisCap, local: AxisCap): AxisCap {
  return {
    cap: Math.min(offer.cap, local.cap),
    unit: local.unit,
    maxPerCall: minNullable(offer.maxPerCall, local.maxPerCall),
  };
}

/**
 * Clamp an offer's budget envelope to the host's local caps. LOCAL ALWAYS WINS.
 *
 * For every axis the OFFER requests (non-null):
 *   - the host must have a local cap for that axis (M11: absence ⇒ zero ⇒ the
 *     host has not opted in to serve that axis for this fleet) → else REFUSE
 *     `budget_axis_unavailable`;
 *   - units must agree (H14) → else REFUSE `budget_unit_mismatch`;
 *   - the effective cap = min(offer, local), max-per-call = tighter of the two.
 * Axes the offer does not request stay null. Refusal is loud + per-axis so the
 * caller can emit a budget-axis receipt (P-004).
 */
export function clampEnvelopeToLocal(
  offer: BudgetEnvelope,
  local: BudgetEnvelope,
): ClampOutcome {
  const notes: AxisClampNote[] = [];
  const out: { remote: AxisCap | null; local: AxisCap | null } = { remote: null, local: null };

  for (const axis of BUDGET_AXES) {
    const want = offer[axis];
    if (want == null) continue; // offer doesn't touch this axis
    if (!isValidAxisCap(want)) {
      return { ok: false, code: 'invalid_axis_cap', axis, detail: `offer ${axis} axis cap is not a finite non-negative number` };
    }
    const have = local[axis];
    if (have == null) {
      return {
        ok: false,
        code: 'budget_axis_unavailable',
        axis,
        detail: `host has no ${axis}-axis allotment for this fleet (M11 default-zero: a resource must be explicitly allotted before it can be drawn)`,
      };
    }
    if (!isValidAxisCap(have)) {
      return { ok: false, code: 'invalid_axis_cap', axis, detail: `host ${axis} axis cap is not a finite non-negative number` };
    }
    if (want.unit !== have.unit) {
      return {
        ok: false,
        code: 'budget_unit_mismatch',
        axis,
        detail: `offer ${axis} axis is denominated in '${want.unit}' but the host meters '${have.unit}' (H14: units must agree — no cross-unit conversion)`,
      };
    }
    const effective = clampAxisToLocal(want, have);
    notes.push({
      axis,
      effective,
      capReduced: effective.cap < want.cap,
      maxPerCallTightened:
        effective.maxPerCall != null &&
        (want.maxPerCall == null || effective.maxPerCall < want.maxPerCall),
    });
    out[axis] = effective;
  }

  return { ok: true, clamped: { remote: out.remote, local: out.local }, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reservation ledger (H11) — pure, functional (no hidden mutation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The in-flight budget ledger for ONE axis of ONE claimed offer. Immutable:
 * every op returns a NEW state. `reservations` are open (reserved-not-yet-spent)
 * envelopes keyed by a caller-supplied id (kept out of this module so it stays
 * pure — the caller mints the id, e.g. per model call).
 *
 * The load-bearing invariant (asserted exhaustively in the property tests):
 *   committed >= 0  AND  committed + Σreservations <= cap
 * i.e. the host can NEVER over-spend an axis, in-flight reservations included.
 */
export interface LedgerState {
  readonly cap: number;
  readonly maxPerCall: number | null;
  readonly unit: BudgetUnit;
  readonly committed: number;
  readonly reservations: Readonly<Record<string, number>>;
}

export function createLedger(axis: AxisCap): LedgerState {
  return { cap: axis.cap, maxPerCall: axis.maxPerCall, unit: axis.unit, committed: 0, reservations: {} };
}

export function reservedTotal(s: LedgerState): number {
  let sum = 0;
  for (const k in s.reservations) sum += s.reservations[k]!;
  return sum;
}

/** cap − committed − in-flight reservations. Never negative in a valid ledger. */
export function remaining(s: LedgerState): number {
  return s.cap - s.committed - reservedTotal(s);
}

export type ReserveResult =
  | { ok: true; state: LedgerState; reservationId: string; amount: number }
  | { ok: false; code: 'invalid_amount' | 'duplicate_reservation' | 'max_per_call_exceeded' | 'budget_exhausted'; detail: string };

/**
 * Reserve `amount` in-flight against the ledger under `reservationId` (H11).
 * Refuses (loud, structured) when the amount is non-positive, exceeds the
 * max-per-call clamp, or would push committed+reserved past the cap. On success
 * the amount is held (not yet spent) until commit()/release().
 */
export function reserve(s: LedgerState, amount: number, reservationId: string): ReserveResult {
  if (!(Number.isFinite(amount) && amount > 0)) {
    return { ok: false, code: 'invalid_amount', detail: `reservation amount must be finite and > 0 (got ${amount})` };
  }
  if (reservationId in s.reservations) {
    return { ok: false, code: 'duplicate_reservation', detail: `reservation id '${reservationId}' is already open` };
  }
  if (s.maxPerCall != null && amount > s.maxPerCall) {
    return {
      ok: false,
      code: 'max_per_call_exceeded',
      detail: `call would reserve ${amount} > max-per-call ${s.maxPerCall} (H11: one call cannot blow past the clamp)`,
    };
  }
  if (amount > remaining(s)) {
    return {
      ok: false,
      code: 'budget_exhausted',
      detail: `call would reserve ${amount} but only ${remaining(s)} remains (cap ${s.cap}, committed ${s.committed}, in-flight ${reservedTotal(s)})`,
    };
  }
  return {
    ok: true,
    reservationId,
    amount,
    state: { ...s, reservations: { ...s.reservations, [reservationId]: amount } },
  };
}

export type CommitResult =
  | { ok: true; state: LedgerState; committedAmount: number }
  | { ok: false; code: 'unknown_reservation' | 'commit_exceeds_reservation' | 'invalid_amount'; detail: string };

/**
 * Settle an open reservation: move (up to) the reserved amount into `committed`
 * and drop the reservation. `actualAmount` defaults to the full reservation; a
 * smaller actual REFUNDS the difference (the reservation is released, only the
 * actual is committed). A larger actual is refused — you cannot spend more than
 * you reserved (that is the whole point of the in-flight envelope).
 */
export function commit(s: LedgerState, reservationId: string, actualAmount?: number): CommitResult {
  const reserved = s.reservations[reservationId];
  if (reserved == null) {
    return { ok: false, code: 'unknown_reservation', detail: `no open reservation '${reservationId}'` };
  }
  const actual = actualAmount ?? reserved;
  if (!(Number.isFinite(actual) && actual >= 0)) {
    return { ok: false, code: 'invalid_amount', detail: `commit amount must be finite and >= 0 (got ${actual})` };
  }
  if (actual > reserved) {
    return {
      ok: false,
      code: 'commit_exceeds_reservation',
      detail: `cannot commit ${actual} > reserved ${reserved} (an over-spend past the in-flight envelope)`,
    };
  }
  const { [reservationId]: _drop, ...rest } = s.reservations;
  void _drop;
  return { ok: true, committedAmount: actual, state: { ...s, committed: s.committed + actual, reservations: rest } };
}

/** Drop a reservation without spending (the call was cancelled / never ran). */
export function release(s: LedgerState, reservationId: string): LedgerState {
  if (!(reservationId in s.reservations)) return s;
  const { [reservationId]: _drop, ...rest } = s.reservations;
  void _drop;
  return { ...s, reservations: rest };
}

/**
 * Is the axis exhausted for scheduling purposes? True when less than one
 * minimum-viable call could be reserved. `minViableCall` defaults to 1 (the
 * smallest positive unit); pass a realistic floor to stop scheduling before the
 * remainder is uselessly small.
 */
export function isExhausted(s: LedgerState, minViableCall = 1): boolean {
  return remaining(s) < minViableCall;
}

// ─────────────────────────────────────────────────────────────────────────────
// Liveness (H12) + TTL / expiry (H16) — pure decisions
// ─────────────────────────────────────────────────────────────────────────────

export type OfferLiveness = 'live' | 'cancelled' | 'wind-down';

/**
 * H12: resolve a claimed offer's liveness. An explicit cancel signal (delivered
 * via coord wake) wins immediately. Otherwise the executor revalidates against a
 * liveness TTL measured from the last CONFIRMED liveness — and DEFAULTS TO
 * WIND-DOWN when it cannot confirm within the TTL (a partition must fail safe,
 * not keep spending on possibly-cancelled work). Clock skew (now < confirmed) is
 * treated as live (never wind down on a backwards clock).
 */
export function resolveOfferLiveness(input: {
  cancelSignalSeen: boolean;
  lastConfirmedAt: number;
  now: number;
  livenessTtlMs: number;
}): OfferLiveness {
  if (input.cancelSignalSeen) return 'cancelled';
  if (!(input.livenessTtlMs > 0)) return 'wind-down'; // no confirmation window ⇒ cannot confirm ⇒ safe default
  const age = input.now - input.lastConfirmedAt;
  if (age < 0) return 'live'; // clock skew — do not wind down
  return age > input.livenessTtlMs ? 'wind-down' : 'live';
}

/** H16: has an UNCLAIMED offer outlived its TTL? (arrival-clock, H8). */
export function isOfferExpired(offer: Pick<WorkOffer, 'publishedAt' | 'ttlMs'>, now: number): boolean {
  return now - offer.publishedAt > offer.ttlMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Publisher rate cap (H16) — pure sliding window
// ─────────────────────────────────────────────────────────────────────────────

/** Per-publisher accepted-offer timestamps, newest-last. Prune-on-check. */
export interface PublisherWindow {
  readonly stamps: readonly number[];
}

export function emptyPublisherWindow(): PublisherWindow {
  return { stamps: [] };
}

export type PublisherRateResult =
  | { ok: true; state: PublisherWindow; countInWindow: number }
  | { ok: false; code: 'publisher_rate_exceeded'; detail: string; state: PublisherWindow };

/**
 * H16: enforce a publisher's max-offers-per-window HOST-SIDE. Prunes stamps
 * older than the window, then admits `now` iff the window holds < maxOffers.
 * On refusal the state is returned pruned-but-unchanged (the offer is NOT
 * recorded — a refused offer must not count toward the next window).
 */
export function recordAndCheckPublisherRate(
  state: PublisherWindow,
  now: number,
  opts: { windowMs: number; maxOffers: number },
): PublisherRateResult {
  const cutoff = now - opts.windowMs;
  const pruned = state.stamps.filter((t) => t > cutoff);
  if (pruned.length >= opts.maxOffers) {
    return {
      ok: false,
      code: 'publisher_rate_exceeded',
      detail: `publisher already has ${pruned.length} offers in the last ${opts.windowMs}ms (cap ${opts.maxOffers})`,
      state: { stamps: pruned },
    };
  }
  return { ok: true, state: { stamps: [...pruned, now] }, countInWindow: pruned.length + 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wind-down decision (pure) — feeds the receipt bridge (./offer-budget-receipts)
// ─────────────────────────────────────────────────────────────────────────────

export type WindDownCause =
  | 'budget_exhausted'
  | 'cancelled'
  | 'liveness_unconfirmable'
  | 'offer_expired'
  | 'quota_exceeded';

export interface WindDownDecision {
  readonly cause: WindDownCause;
  readonly axis: BudgetAxis | null;
  readonly detail: string;
  /**
   * X8 receipt taxonomy: preemption-class interruptions (an explicit cancel /
   * kill-switch) are EXCUSED breaches — they must not dent host reliability.
   * Budget exhaustion, expiry, and unconfirmable-liveness are plain refusals.
   */
  readonly receiptKind: 'refusal' | 'excused-breach';
}

/** Map a wind-down cause to its decision, incl. the X8 receipt kind. */
export function decideWindDown(
  cause: WindDownCause,
  opts?: { axis?: BudgetAxis | null; detail?: string },
): WindDownDecision {
  const axis = opts?.axis ?? null;
  const receiptKind: 'refusal' | 'excused-breach' = cause === 'cancelled' ? 'excused-breach' : 'refusal';
  const defaultDetail: Record<WindDownCause, string> = {
    budget_exhausted: `offer wound down: ${axis ?? 'a'}-axis budget exhausted (graceful — in-flight calls drain, no new calls scheduled)`,
    cancelled: 'offer wound down: cancelled by the publisher (preemption-class, excused breach)',
    liveness_unconfirmable: 'offer wound down: liveness could not be confirmed within the TTL (partition — failing safe)',
    offer_expired: 'offer wound down: unclaimed-offer TTL elapsed (H16)',
    quota_exceeded: 'offer wound down: foreign workspace exceeded its disk quota (P-105 §1)',
  };
  return { cause, axis, detail: opts?.detail ?? defaultDetail[cause], receiptKind };
}

/**
 * Map a ReserveResult refusal `code` to the budget-axis wind-down cause, so the
 * scheduler can turn "this call can't be reserved" into a wind-down decision
 * without re-deriving intent. `max_per_call_exceeded` is NOT a wind-down — the
 * offer is still live, just this one oversized call is refused.
 */
export function reserveRefusalToWindDown(
  code: Exclude<ReserveResult, { ok: true }>['code'],
  axis: BudgetAxis,
): WindDownDecision | null {
  return code === 'budget_exhausted' ? decideWindDown('budget_exhausted', { axis }) : null;
}
