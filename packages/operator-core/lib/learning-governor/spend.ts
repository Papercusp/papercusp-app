/**
 * Learning spend RESERVATION + SETTLEMENT — the pure core
 * (blender-evidence-driven-learning-redesign-2026-09-04 P-005).
 *
 * BEFORE this module the governor was POST-HOC ONLY: `recordLearningSpend`
 * appended a cost event and bumped `spent_usd` AFTER a cycle reported a cost.
 * Two things fall through that design, and both are what P-005 names:
 *
 *   1. An attempt IN FLIGHT is invisible. `checkLoopVerdict` reasons over
 *      `budget − spent`, so N concurrent attempts each see the same headroom
 *      and can collectively overspend it. Nothing is wrong with any single
 *      decision; the ledger simply cannot represent "committed but not yet
 *      charged".
 *   2. An attempt that CANCELS or FAILS ledgers NOTHING — `recordGymTickToGovernor`
 *      and `recordScoutTickToGovernor` both guard on `costUsd > 0`. A proposer
 *      call that burned tokens and then threw, or an evaluation that completed
 *      3 of 10 tasks, leaves no trace at all, so the loop's own spend is
 *      systematically UNDER-reported in exactly the situations where a human
 *      most wants to look.
 *
 * The fix is the reserve/settle pair every budget ledger uses: an attempt
 * RESERVES before it spends and SETTLES exactly once afterwards, whatever its
 * outcome — used (in full or in part), cancelled, or failed. The four amounts
 * P-005 asks to see separately fall straight out of that lifecycle:
 *
 *   requested  what the attempt ASKED for
 *   reserved   what the governor GRANTED (≤ requested; clamped to headroom)
 *   used       what settlement actually CHARGED
 *   unsettled  reserved on attempts still OPEN — the in-flight number the old
 *              ledger could not represent, and the one that makes a stuck or
 *              crashed attempt visible instead of silent
 *
 * Those are the field names of `LearningSpend` in experiment/types.ts (P-001),
 * deliberately: `toLearningSpend()` below feeds `validateLearningContract()`
 * directly, so the governor's arithmetic and the learning contract's
 * invariants cannot drift apart.
 *
 * Pure by construction (no SQL, no clock) — store.ts binds it to migration
 * 1116 and is covered by store.integration.test.ts; the decisions here are
 * covered by spend.test.ts.
 */
import type { LearningSpend } from '../experiment/types';
import {
  LEARNING_GOVERNOR_BUDGET_FLOOR_USD,
  remainingLoopBudgetUsd,
  type LearningLoopRegistration,
} from './core';

// ---------------------------------------------------------------------------
// Vocabulary (columns stay plain `text`, mirroring migration 244's posture so
// the seam can evolve the vocabulary without a migration)
// ---------------------------------------------------------------------------

/**
 * What KIND of spend attempt this is. The distinction P-005 cares about is
 * that a proposer call and a partial evaluation are separately closable
 * attempts, not phases of one uncloseable "cycle".
 */
export type SpendAttemptKind = 'proposer' | 'evaluation' | 'promotion' | 'cycle';

/** `open` is the only non-terminal status; the other three are all settlements. */
export type SpendReservationStatus = 'open' | 'settled' | 'cancelled' | 'failed';

/** How an attempt ENDED. Every attempt ends in exactly one of these. */
export type SpendDisposition = 'used' | 'cancelled' | 'failed';

export type ReservationRefusal =
  /** requestedUsd is negative, NaN, or infinite. */
  | 'invalid-amount'
  /** The registration has no budget — the same fail-closed posture as the D-004 preflight. */
  | 'unbudgeted'
  /** Budget minus spend minus already-open reservations leaves nothing above the floor. */
  | 'no-headroom';

// ---------------------------------------------------------------------------
// Headroom
// ---------------------------------------------------------------------------

/**
 * How much a NEW attempt may reserve right now.
 *
 * `null` means there is no budget to reason about (the D-004 unbudgeted row);
 * callers must treat that as a REFUSAL, never as "unbounded" — an unbudgeted
 * loop is precisely the one the governor exists to stop.
 *
 * Lifetime rows subtract three things from the cap: spend already charged,
 * spend already RESERVED by open attempts (the new term — this is what makes
 * concurrent attempts safe), and the floor `checkLoopVerdict` refuses at, so a
 * reservation can never walk a loop into `exhausted` behind the gate's back.
 *
 * Per-cycle rows report their per-run cap unchanged. Their contract is that the
 * LOOP bounds each run at that cap (`checkScoutBudget`-style, enforcement
 * `native`), so open attempts on other runs are deliberately not charged
 * against it and the lifetime drain floor does not apply. Reservations on those
 * rows still ledger — they are what makes a cancelled scout cycle visible —
 * they just do not gate.
 */
export function reservationHeadroomUsd(
  reg: Pick<LearningLoopRegistration, 'budgetKind' | 'budgetUsd' | 'spentUsd'> | null | undefined,
  openReservedUsd = 0,
  floorUsd: number = LEARNING_GOVERNOR_BUDGET_FLOOR_USD,
): number | null {
  if (!reg || reg.budgetUsd === null) return null;
  if (reg.budgetKind === 'per-cycle') return Math.max(0, reg.budgetUsd);
  const remaining = remainingLoopBudgetUsd(reg) ?? 0;
  const open = Number.isFinite(openReservedUsd) && openReservedUsd > 0 ? openReservedUsd : 0;
  return Math.max(0, remaining - open - floorUsd);
}

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------

export interface ReservationPlan {
  readonly ok: boolean;
  /** What the governor grants. 0 on refusal. */
  readonly reservedUsd: number;
  readonly reason?: ReservationRefusal;
  /** True when headroom granted LESS than was requested — the attempt must bound itself to `reservedUsd`. */
  readonly clamped: boolean;
  /** Echoed so a refusal explains itself without a second read. */
  readonly headroomUsd: number | null;
}

/**
 * Decide one reservation. A partial grant is an ALLOW, not a refusal: the
 * attempt is told to bound itself at `reservedUsd` (`clamped: true`), which is
 * strictly better than refusing work that fits in the remaining budget.
 */
export function planReservation(input: {
  requestedUsd: number;
  headroomUsd: number | null;
}): ReservationPlan {
  const { requestedUsd, headroomUsd } = input;
  if (!Number.isFinite(requestedUsd) || requestedUsd < 0) {
    return { ok: false, reservedUsd: 0, reason: 'invalid-amount', clamped: false, headroomUsd };
  }
  // Fail CLOSED on an unbudgeted row, exactly like the preflight: no budget is
  // not "no limit".
  if (headroomUsd === null) {
    return { ok: false, reservedUsd: 0, reason: 'unbudgeted', clamped: false, headroomUsd };
  }
  // A zero-cost attempt still reserves (at 0) and still settles — that is how a
  // free proposer call stays visible in the ledger rather than vanishing.
  if (requestedUsd === 0) return { ok: true, reservedUsd: 0, clamped: false, headroomUsd };
  if (headroomUsd <= 0) {
    return { ok: false, reservedUsd: 0, reason: 'no-headroom', clamped: false, headroomUsd };
  }
  const reservedUsd = Math.min(requestedUsd, headroomUsd);
  return { ok: true, reservedUsd, clamped: reservedUsd < requestedUsd, headroomUsd };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export interface Settlement {
  readonly status: Exclude<SpendReservationStatus, 'open'>;
  /** What is CHARGED. Never silently clamped — see `overrunUsd`. */
  readonly usedUsd: number;
  /** Reservation returned to headroom (0 on an overrun). */
  readonly releasedUsd: number;
  /** Charge beyond the reservation. Real money, so it is charged AND flagged. */
  readonly overrunUsd: number;
}

/**
 * Close one attempt. Every disposition produces a settlement — that is the
 * point: `cancelled` and `failed` are ledger events, not the absence of one.
 *
 * On an OVERRUN (`usedUsd > reservedUsd`) the used amount is recorded in full
 * and reported as `overrunUsd`. Clamping would under-report spend that was
 * genuinely burned, which is the exact failure this module exists to remove;
 * the positions rollup below reconciles the invariant by treating the
 * reservation as having grown to what was actually consumed.
 *
 * A `failed` attempt may still have burned money (a proposer call that threw
 * after the tokens were spent), so it takes `usedUsd` like any other. It
 * defaults to 0 for the common case where nothing was charged.
 */
export function settleReservation(input: {
  reservedUsd: number;
  disposition: SpendDisposition;
  usedUsd?: number;
}): Settlement {
  const reserved = Number.isFinite(input.reservedUsd) && input.reservedUsd > 0 ? input.reservedUsd : 0;
  // Every disposition may carry a charge: a cancellation can land after the
  // first proposer call has already burned tokens, so `cancelled` is not
  // synonymous with `usedUsd === 0`.
  const rawUsed = input.usedUsd ?? 0;
  const used = Number.isFinite(rawUsed) && rawUsed > 0 ? rawUsed : 0;
  const status: Exclude<SpendReservationStatus, 'open'> =
    input.disposition === 'used' ? 'settled' : input.disposition;
  return {
    status,
    usedUsd: used,
    releasedUsd: Math.max(0, reserved - used),
    overrunUsd: Math.max(0, used - reserved),
  };
}

// ---------------------------------------------------------------------------
// The four amounts, exposed separately (the P-005 deliverable)
// ---------------------------------------------------------------------------

export interface SpendPositionRow {
  readonly requestedUsd: number;
  readonly reservedUsd: number;
  readonly usedUsd: number;
  readonly status: SpendReservationStatus;
}

export interface LearningSpendPositions {
  readonly requestedUsd: number;
  readonly reservedUsd: number;
  readonly usedUsd: number;
  /** Reserved on attempts that have NOT settled — the in-flight/stuck number. */
  readonly unsettledUsd: number;
  /** How many attempts are still open (0 ⇒ every attempt in the window closed). */
  readonly openAttempts: number;
  /** Attempts that settled having charged beyond their reservation. */
  readonly overrunAttempts: number;
}

const ZERO_POSITIONS: LearningSpendPositions = {
  requestedUsd: 0,
  reservedUsd: 0,
  usedUsd: 0,
  unsettledUsd: 0,
  openAttempts: 0,
  overrunAttempts: 0,
};

const n = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Roll rows up into the four amounts.
 *
 * The one non-obvious rule is overrun reconciliation. `validateLearningContract`
 * requires `reserved ≤ requested` and `used + unsettled ≤ reserved`; an attempt
 * that burned past its reservation violates both while being perfectly honest
 * about the money. So an overrun row is summed as though the reservation had
 * grown to what was actually consumed (and the request with it). Nothing is
 * hidden — `overrunAttempts` counts them — but the rollup stays a valid
 * `LearningSpend` instead of producing a contract the validator rejects.
 */
export function summarizeSpendPositions(
  rows: readonly SpendPositionRow[],
): LearningSpendPositions {
  if (rows.length === 0) return ZERO_POSITIONS;
  let requested = 0;
  let reserved = 0;
  let used = 0;
  let unsettled = 0;
  let open = 0;
  let overrun = 0;
  for (const r of rows) {
    const rowUsed = r.status === 'open' ? 0 : n(r.usedUsd);
    const rowReserved = Math.max(n(r.reservedUsd), rowUsed);
    if (rowUsed > n(r.reservedUsd)) overrun += 1;
    requested += Math.max(n(r.requestedUsd), rowReserved);
    reserved += rowReserved;
    used += rowUsed;
    if (r.status === 'open') {
      unsettled += rowReserved;
      open += 1;
    }
  }
  return {
    requestedUsd: requested,
    reservedUsd: reserved,
    usedUsd: used,
    unsettledUsd: unsettled,
    openAttempts: open,
    overrunAttempts: overrun,
  };
}

/**
 * Project the positions onto the P-001 learning contract's `LearningSpend`.
 * `settledAt` is supplied only when the window has no open attempts — a spend
 * record with work still in flight is not settled, and saying so is the whole
 * value of the `unsettled` column.
 */
export function toLearningSpend(
  positions: LearningSpendPositions,
  settledAt?: string,
): LearningSpend {
  const closed = positions.openAttempts === 0 && positions.unsettledUsd === 0;
  return {
    requestedUsd: positions.requestedUsd,
    reservedUsd: positions.reservedUsd,
    usedUsd: positions.usedUsd,
    unsettledUsd: positions.unsettledUsd,
    ...(closed && settledAt ? { settledAt } : {}),
  };
}
