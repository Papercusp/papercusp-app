/**
 * Will this owner's loop actually deliver one more wake if the current turn settles?
 *
 * A LEAF module on purpose (type-only imports): `loop:checkpoint`'s continuation gate and
 * `loop:status` both answer this question, and they must answer it with the same code.
 * It lived inside checkpoint.ts until P-013 (review-system-rework-reduction-2026-09-23)
 * needed `loop:status` to report it too, and importing the whole checkpoint tool into a
 * lightweight status read would have dragged its entire dependency graph along.
 *
 * `active` alone is insufficient. The dead-man guard runs immediately before delivery
 * and deliberately withholds the next wake once either arm-relative bound is exhausted.
 * Reporting `rewakeGuaranteed:true` from a merely-active row in that state gives an AUTO
 * session the exact false reassurance the continuation gate exists to prevent: it ends
 * its last turn, the guard disarms the loop, and no next turn arrives.
 *
 * Mirror the guard's comparisons:
 *   - `firesSinceArm >= maxFires` withholds the next fire;
 *   - `nextAttemptAt - armedAt > maxDurationSec` withholds the next fire.
 *
 * A parked loop has no concrete `nextFireAt`; if this turn settled now, reconciliation
 * would schedule it one interval from now, so that is the earliest candidate attempt.
 * Missing arm-time evidence under a configured duration bound cannot support a guarantee
 * (the fire path falls back to `created_at`, which this status shape intentionally does not
 * expose), so fail closed rather than inventing headroom.
 *
 * EI-22089924844237484 — a THIRD dead-man shape distinct from the two above: an active,
 * un-parked loop whose current arm has produced ZERO fires despite at least two
 * interval-sized opportunities having elapsed (`expectedFiresSinceArm >= 2`), with a
 * concrete `nextFireAt` sitting in the past. This is what "the whole routine engine
 * (bg-host) is down" looks like from a loop row: the loop was never parked (no in-flight
 * turn to be stuck in), so `LoopStatus.stalled`/fire-starvation — which both hard-require
 * `parked` — read false; and cadence-drift needs >=3 HISTORICAL fires to compute a slow
 * ratio, so a fresh arm sitting at zero fires can never trip it either. See
 * EI-22089924844237484 for the full incident (loop armed 19:43Z, 0 fires by 19:47Z against
 * 4 expected, because a peer's seed re-cut had quiesced bg-host for the whole window).
 *
 * Fire starvation is read from LoopStatus.fireStarved, which the status writer computes
 * from cadence, recent activity, and the scheduler's next-fire time. Do not recompute it
 * here: suppressed-redundant wakes can leave an overdue schedule and zero loop fires
 * while a real turn is actively settling.
 *
 * A fourth shape, P-013 / EI-24023838400909760: the loop's newest fire PARKED undelivered
 * (see {@link lastLoopFireParked}).
 */
import type { LoopStatus } from '../../harness/routines/loop';
import type { ActiveLoopRewakeBlockedReason } from '../coordination/tools/continuation-gate';

export type LoopNextWakeInput =
  | (Pick<
      LoopStatus,
      | 'active'
      | 'armedAt'
      | 'firesSinceArm'
      | 'intervalSec'
      | 'maxDurationSec'
      | 'maxFires'
      | 'nextFireAt'
      | 'parked'
      | 'fireStarved'
    > &
      // Optional so hand-built inputs (and older fixtures) stay valid; getLoopStatus
      // always populates both from the loop's newest wake-delivery row.
      Partial<Pick<LoopStatus, 'lastWakeStatus' | 'lastWakeError'>>)
  | null
  | undefined;

/**
 * P-013 (review-system-rework-reduction-2026-09-23) / EI-24023838400909760: did this
 * loop's most recent fire PARK undelivered on a path that will park again?
 *
 * Measured: a cold loop re-armed and was told `rewakeGuaranteed:true` while its previous
 * fire had parked with "eligible cold loop wake has no injectable psu host"; the next
 * fire parked the same way and the session went dark until a peer woke it by hand. An
 * active, in-bounds loop is not a guarantee when its delivery path is the thing that is
 * broken.
 *
 * Two park shapes are EXCLUDED because they already carry a durable retry on a path that
 * demonstrably works: a psu host that accepted the delivery but has not yet proven turn
 * start, and a quota-recovery operation retry. Their reasons end "retry remains durable".
 */
export function lastLoopFireParked(
  loop: Partial<Pick<LoopStatus, 'lastWakeStatus' | 'lastWakeError'>> | null | undefined,
): boolean {
  if (loop?.lastWakeStatus !== 'parked') return false;
  return !/retry remains durable/i.test(loop.lastWakeError ?? '');
}

export type LoopNextWakeVerdict =
  | { guaranteed: true; reason: null }
  | { guaranteed: false; reason: 'no-active-loop' | ActiveLoopRewakeBlockedReason };

/** Classify the same guard as loopGuaranteesNextWake, retaining WHY an active
 *  row is not a usable continuation guarantee for checkpoint guidance. */
export function classifyLoopNextWake(
  loop: LoopNextWakeInput,
  nowMs: number = Date.now(),
): LoopNextWakeVerdict {
  if (!loop?.active) return { guaranteed: false, reason: 'no-active-loop' };

  if (loop.maxFires != null && loop.maxFires > 0 && loop.firesSinceArm >= loop.maxFires) {
    return { guaranteed: false, reason: 'max-fires-exhausted' };
  }

  if (loop.maxDurationSec != null && loop.maxDurationSec > 0) {
    const armedAtMs = loop.armedAt == null ? Number.NaN : Date.parse(loop.armedAt);
    if (!Number.isFinite(armedAtMs)) return { guaranteed: false, reason: 'max-duration-unverifiable' };

    const scheduledAtMs = loop.nextFireAt == null ? Number.NaN : Date.parse(loop.nextFireAt);
    if (!Number.isFinite(scheduledAtMs) && loop.intervalSec == null) {
      return { guaranteed: false, reason: 'max-duration-unverifiable' };
    }
    const nextAttemptAtMs = Number.isFinite(scheduledAtMs)
      ? Math.max(nowMs, scheduledAtMs)
      : nowMs + Math.max(0, loop.intervalSec!) * 1_000;
    if (nextAttemptAtMs - armedAtMs > loop.maxDurationSec * 1_000) {
      return { guaranteed: false, reason: 'max-duration-exhausted' };
    }
  }

  if (loop.fireStarved) return { guaranteed: false, reason: 'fire-starved' };

  // P-013 / EI-24023838400909760: the last fire parked undelivered — the next one on the
  // same delivery path is expected to park too, so this loop does not guarantee a wake.
  if (lastLoopFireParked(loop)) return { guaranteed: false, reason: 'last-fire-parked' };

  return { guaranteed: true, reason: null };
}

export function loopGuaranteesNextWake(loop: LoopNextWakeInput, nowMs: number = Date.now()): boolean {
  return classifyLoopNextWake(loop, nowMs).guaranteed;
}
