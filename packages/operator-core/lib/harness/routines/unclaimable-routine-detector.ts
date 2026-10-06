/**
 * unclaimable-routine-detector.ts — WI-40883.
 *
 * THE DETECTOR THAT SHOULD HAVE CAUGHT IT. A µs-vs-ms precision mismatch made
 * `claimDueRoutine`'s optimistic-concurrency guard unsatisfiable, so 11 active routines were
 * skipped on every tick and never fired once — one of them green-checkpoint for three pots,
 * dark for ~36 hours. The cause is fixed (claim.ts + migration 909), but the reason it went
 * unnoticed for that long is structural and outlives that particular cause:
 * `routinesTickImpl` swallows a failed claim with a bare `if (!claimed) continue;`.
 *
 * That silence is CORRECT for the common case — two executors race for the same due routine
 * every tick, exactly one wins, and the loser must say nothing. The bug hid inside that
 * expected noise. What distinguishes a lost race from a permanently unclaimable row is not the
 * failure itself but HOW LONG the row has been due: a race resolves within one tick, so a
 * routine that is still due half an hour later is not losing races, it is unreachable.
 *
 * This module is the pure decider for that distinction (no I/O, so every interesting case is
 * unit-testable without a populated operator) plus the durable stamp that makes the verdict
 * QUERYABLE rather than a log line nobody reads — `routines:list` surfaces metadata.health, so
 * a dark routine can be found by asking instead of by noticing.
 *
 * Deliberately cause-agnostic: it says "this row is not being claimed and here is the
 * evidence", never "because of timestamp precision". The next cause will be a different one.
 */

/** The claim-skip facts the tick already holds when a claim returns false. */
export interface ClaimSkipInput {
  id: string;
  name: string;
  installSlug: string;
  /** The row's due time as the tick read it. NULL is a valid due value (due-by-NULL). */
  nextFireAt: Date | null;
  /** NULL ⇒ this routine has never fired in its life — the strongest single signal. */
  lastFiredAt: Date | null;
}

export type ClaimSkipVerdict =
  | { state: 'race'; reason: string; overdueMs: number | null }
  | { state: 'unclaimable'; reason: string; overdueMs: number | null; neverFired: boolean };

/**
 * A routine still due this long after the tick tried to claim it is not losing a race.
 * Sized well above the tick cadence (seconds) and above any plausible claim contention, and
 * below the shortest routine period that matters here (green-checkpoint, hourly), so a healthy
 * routine can never reach it: a claimed row's next_fire_at jumps into the FUTURE immediately.
 */
export const UNCLAIMABLE_AFTER_MS = 30 * 60_000;

export function classifyClaimSkip(
  input: ClaimSkipInput,
  nowMs: number,
  overdueThresholdMs: number = UNCLAIMABLE_AFTER_MS,
): ClaimSkipVerdict {
  const neverFired = input.lastFiredAt == null;

  // Due-by-NULL: there is no due time to measure staleness against, so age cannot separate a
  // race from a wedge. Report it as a race (say nothing) rather than inventing an alarm — a
  // NULL next_fire_at that is genuinely stuck still surfaces via the never-fired census.
  if (input.nextFireAt == null) {
    return { state: 'race', reason: 'due-by-NULL: no due time to age', overdueMs: null };
  }

  const overdueMs = nowMs - input.nextFireAt.getTime();

  // Not yet overdue enough to distinguish. A single lost race looks exactly like this, and it
  // is BY FAR the common case, so the default must be silence.
  if (overdueMs < overdueThresholdMs) {
    return {
      state: 'race',
      reason: `claim lost but only ${Math.round(overdueMs / 1000)}s overdue — within race window`,
      overdueMs,
    };
  }

  const mins = Math.round(overdueMs / 60_000);
  return {
    state: 'unclaimable',
    overdueMs,
    neverFired,
    reason:
      `routine '${input.name}' (${input.installSlug}) could not be claimed and has been due for ` +
      `${mins}m` +
      (neverFired
        ? ' — and has NEVER fired. An active, due routine that no tick can claim is unreachable, ' +
          'not contended: its handler has never run and will not run until this is fixed.'
        : ' — it last fired at ' +
          // WI-10005062: tolerate a string — a raw timestamptz once reached here, and this
          // classifier's throw aborted routinesTick dispatch for every later due routine.
          new Date(input.lastFiredAt as Date | string).toISOString() +
          ' and has been skipped by every tick since.'),
  };
}

/**
 * Stamp the verdict on the row so it is queryable (`routines:list` → metadata.health).
 * Fail-soft and never awaited by the tick: this is an instrument on the fire hot path and must
 * never delay, or fail, routine dispatch — an observability write that can break firing would
 * be a worse bug than the one it reports.
 */
export async function recordUnclaimableRoutine(
  sql: any,
  routineId: string,
  verdict: Extract<ClaimSkipVerdict, { state: 'unclaimable' }>,
): Promise<void> {
  try {
    const patch = JSON.stringify({
      unclaimable: {
        detected_at: new Date().toISOString(),
        overdue_ms: verdict.overdueMs,
        never_fired: verdict.neverFired,
        reason: verdict.reason,
      },
    });
    await sql`
      UPDATE harness_shared.routines
         SET metadata = COALESCE(metadata, '{}'::jsonb) || ${patch}::text::jsonb
       WHERE id = ${routineId}
    `;
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}

/** Clear a previously-stamped unclaimable marker once the routine claims successfully. */
export async function clearUnclaimableRoutine(sql: any, routineId: string): Promise<void> {
  try {
    await sql`
      UPDATE harness_shared.routines
         SET metadata = metadata - 'unclaimable'
       WHERE id = ${routineId} AND metadata ? 'unclaimable'
    `;
  } catch {
    /* fail-soft, as above */
  }
}
