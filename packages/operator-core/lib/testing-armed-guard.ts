/**
 * Vacuous-green protection for guards that arm themselves (EI-19372846096817075).
 *
 * THE SHAPE THIS FIXES. This repo leans — correctly — on structural guards that
 * are introduced BEFORE the cleanup they enforce is finished, using a runtime
 * gate:
 *
 * ```ts
 * const stillRegistered = knownQueryNamesV2().includes('operatorTurns.byConversation');
 * if (!stillRegistered) { expect(mapped).toBe(false); }   // <-- gated
 * ```
 *
 * That is good design: an absolute pin would red the whole fleet's gate for a
 * known, tolerated interim. The cost is that the gate is held open by *the very
 * thing the guard exists to catch*, so while the interim lasts the test executes
 * ZERO assertions and reports a green tick indistinguishable from a real pass.
 * A guard cannot tell you it is asleep.
 *
 * It bit exactly that way on 2026-08-02: `table-to-query-names.test.ts` ran
 * vacuously for ~12h while a plan Decision recorded the deletion as done. Two
 * agents read "guard green + decision says removed" and concluded it had landed.
 * It had not.
 *
 * Note the asymmetry that makes this a class rather than an incident: the interim
 * is always *supposed* to be short, so nobody sets a reminder — and the guard's
 * silence is precisely what removes the pressure to end it.
 *
 * WHAT THIS DOES. Two things the `if (cond) expect(...)` idiom cannot:
 *   1. a dormant guard reports as SKIPPED with its arming condition, not as a
 *      green tick — "not yet armed" and "armed and passing" stop rendering alike;
 *   2. the interim carries an `armBy` date, and once that passes the guard FAILS.
 *      A temporary state that outlives its window becomes loud on its own.
 *
 * `armBy` is deliberately REQUIRED. An optional expiry is one nobody fills in,
 * which reproduces the original bug with a nicer reporter line. This mirrors the
 * `DARK_FLAGS_REVIEW_BY` convention in `libs/flags` — same problem (a tolerated
 * temporary going quiet), same remedy.
 *
 * WHAT THIS IS NOT. It is not a reason to convert gated guards into absolute
 * pins. The gating exists because the interim states are real; an absolute pin
 * turns a tolerable temporary into a red gate for the whole fleet, which is how
 * these interims get created in the first place.
 */

/** The interim state holding a guard's assertion dormant. */
export interface ArmedGuardInterim {
  /**
   * What is holding the gate open, phrased for someone reading a test report
   * with no other context. Rendered verbatim into the skip note.
   */
  readonly why: string;
  /**
   * ISO `YYYY-MM-DD` (UTC). Through this date a dormant guard SKIPS; after it,
   * a dormant guard FAILS. Required on purpose — see the module header.
   */
  readonly armBy: string;
  /** The work-item / decision that closes the interim, e.g. `EI-19372323793235963`. */
  readonly tracking?: string;
}

/**
 * `armed` — the assertion should run.
 * `dormant` — gated off, still inside its window: report as a skip, never a pass.
 * `overdue` — gated off past `armBy`: the interim outlived its window; fail.
 */
export type ArmedGuardVerdict =
  | { readonly kind: 'armed' }
  | { readonly kind: 'dormant'; readonly note: string }
  | { readonly kind: 'overdue'; readonly message: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC calendar date, so the verdict never depends on the runner's timezone. */
function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function trackingSuffix(interim: ArmedGuardInterim): string {
  return interim.tracking ? ` (tracking: ${interim.tracking})` : '';
}

/**
 * The whole decision, as a pure function — no vitest, no clock, no I/O, so the
 * expiry behaviour is directly testable instead of only observable on the day it
 * fires. `expectArmed` is a thin binding over this.
 */
export function armedGuardVerdict(
  armed: boolean,
  interim: ArmedGuardInterim,
  now: Date = new Date(),
): ArmedGuardVerdict {
  // A malformed date cannot be compared, and silently treating it as
  // "never expires" would rebuild the exact bug this module exists to prevent:
  // an expiry that never fires is an expiry nobody has.
  if (!ISO_DATE.test(interim.armBy)) {
    throw new Error(
      `armedGuardVerdict: armBy must be an ISO YYYY-MM-DD date, got ${JSON.stringify(interim.armBy)}. ` +
        'An unparseable expiry would silently never fire, which is the failure this guard exists to prevent.',
    );
  }
  if (armed) return { kind: 'armed' };

  if (utcDate(now) > interim.armBy) {
    return {
      kind: 'overdue',
      message:
        `This guard has been dormant past its armBy date (${interim.armBy}) and has asserted NOTHING since. ` +
        `Holding it open: ${interim.why}${trackingSuffix(interim)}. ` +
        'Either finish the cleanup so the guard arms, or consciously extend armBy with a reason — ' +
        'but do not delete the guard, and do not leave it dormant and quiet.',
    };
  }

  return {
    kind: 'dormant',
    // The note is the entire point: it is what makes a vacuous run legible in
    // the reporter instead of reading as a pass.
    note: `guard not armed — ${interim.why}${trackingSuffix(interim)}; arms by ${interim.armBy}`,
  };
}

/** The slice of vitest's `TestContext` this needs — kept structural so callers can pass `ctx` directly. */
export interface SkippableTestContext {
  readonly skip: (note?: string) => never;
}

/**
 * Call at the top of a guard whose assertions are gated on an interim state.
 *
 * ```ts
 * it('does not map X once its resolver entry is gone', (ctx) => {
 *   const stillRegistered = knownQueryNamesV2().includes('X');
 *   expectArmed(ctx, !stillRegistered, {
 *     why: 'the X resolver entry is still registered',
 *     armBy: '2026-08-09',
 *     tracking: 'EI-19372323793235963',
 *   });
 *   // ...assertions run unconditionally from here
 * });
 * ```
 *
 * When dormant this THROWS (via `ctx.skip`, which is documented to throw), so
 * everything after the call is skipped — the assertions below need no `if`.
 */
export function expectArmed(
  ctx: SkippableTestContext,
  armed: boolean,
  interim: ArmedGuardInterim,
  now: Date = new Date(),
): void {
  const verdict = armedGuardVerdict(armed, interim, now);
  if (verdict.kind === 'armed') return;
  if (verdict.kind === 'overdue') throw new Error(verdict.message);
  ctx.skip(verdict.note);
}
