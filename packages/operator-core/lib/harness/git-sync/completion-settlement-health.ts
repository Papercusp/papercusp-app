/**
 * WI-10004400 / EI-24710716781971154 — the STANDING recurrence guard for the
 * completion-settlement reconciler.
 *
 * The reconciler fix (never-attempted candidates first; the floor-rejected mixed rows
 * attested) was verified once, by hand. Nothing watched it afterwards: the reconciler's
 * per-fire result was DISCARDED at its only call site, so the two failure shapes the
 * original filing described — a fresh close waiting behind a whole rotation, and rows
 * the TS proof settles but the SQL authority floor keeps `proposed` — were both
 * invisible unless someone re-ran a census by hand.
 *
 * This module turns each fire into one persisted observation and a verdict. It is pure
 * and DB-free on purpose (the call site injects the read and the write), and it reuses
 * the health convention `routines:list` already projects: a `<subsystem>_health` key in
 * the routine's metadata surfaces as `health.completion_settlement_health` with no
 * reader change, so the guard is one `routines:list { name:'git-sync' }` read away.
 *
 * Verdict semantics (the two conditions the filing asked for):
 *  - `never-attempted`: proposed candidates that have NEVER been attempted (no
 *    `residualPaths` key) still remain after N consecutive measured fires. A fresh close
 *    can only be in this tier, so this is exactly "a new close is not being reached".
 *    It also flags rows the pass cannot read at all — they are never-attempted forever,
 *    and that is a real defect, not noise.
 *  - `floor-rejected`: the TS proof said zero residual but the SQL authority floor kept
 *    the row `proposed`, on N consecutive fires that could measure it (a fire that ended
 *    on its budget or an error measures nothing and leaves the streak untouched).
 */
export const COMPLETION_SETTLEMENT_HEALTH_KEY = 'completion_settlement_health';

/** Consecutive measured fires with never-attempted candidates still waiting before the guard fails. */
export const NEVER_ATTEMPTED_WAIT_FIRES_LIMIT = 3;
/** Consecutive measured fires with a floor rejection before the guard fails. */
export const FLOOR_REJECTED_CONSECUTIVE_FIRES_LIMIT = 2;
/**
 * EI-24807349327024992: consecutive measured fires on which the exact-tree lookup returned
 * nothing for at least one row before the guard fails. One fire is a transient (a git timeout
 * under load); a run of them means rows are being skipped instead of settled.
 */
export const LOOKUP_UNAVAILABLE_CONSECUTIVE_FIRES_LIMIT = 3;

export type SettlementFireObservation =
  | {
      outcome: 'completed';
      inspected: number;
      upgraded: number;
      residual: number;
      unreadable: number;
      floorRejected: number;
      /** Rows skipped because the exact-tree lookup returned nothing (nothing written for them). */
      lookupUnavailable: number;
      /** DB count after the pass; null when the count itself could not be read. */
      neverAttemptedRemaining: number | null;
    }
  | {
      /** The pass was cut short, so its per-row stats are unknown — say so, do not zero them. */
      outcome: 'budget-exceeded' | 'error';
      neverAttemptedRemaining: number | null;
      error?: string;
    };

export interface CompletionSettlementHealth {
  observed_at: string;
  last_outcome: SettlementFireObservation['outcome'];
  inspected: number | null;
  upgraded: number | null;
  residual: number | null;
  unreadable: number | null;
  floor_rejected: number | null;
  lookup_unavailable: number | null;
  never_attempted_remaining: number | null;
  consecutive_never_attempted_fires: number;
  consecutive_floor_rejected_fires: number;
  consecutive_lookup_unavailable_fires: number;
  verdict: 'ok' | 'failing';
  reasons: string[];
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Fold one fire's observation into the previous persisted health (any shape) and judge it. */
export function advanceCompletionSettlementHealth(
  previous: unknown,
  observation: SettlementFireObservation,
  nowMs: number,
): CompletionSettlementHealth {
  const prev = previous && typeof previous === 'object' ? (previous as Record<string, unknown>) : {};

  // An unmeasured count holds the streak: "could not read" is not evidence of recovery.
  const neverAttemptedStreak =
    observation.neverAttemptedRemaining === null
      ? count(prev.consecutive_never_attempted_fires)
      : observation.neverAttemptedRemaining > 0
        ? count(prev.consecutive_never_attempted_fires) + 1
        : 0;

  // Only a completed pass can see a floor rejection; a cut-short pass holds the streak.
  const floorRejectedStreak =
    observation.outcome === 'completed'
      ? observation.floorRejected > 0
        ? count(prev.consecutive_floor_rejected_fires) + 1
        : 0
      : count(prev.consecutive_floor_rejected_fires);

  // Same rule as the floor streak. `count` treats an older observation without the field as 0.
  const lookupUnavailableStreak =
    observation.outcome === 'completed'
      ? count(observation.lookupUnavailable) > 0
        ? count(prev.consecutive_lookup_unavailable_fires) + 1
        : 0
      : count(prev.consecutive_lookup_unavailable_fires);

  const reasons: string[] = [];
  if (neverAttemptedStreak >= NEVER_ATTEMPTED_WAIT_FIRES_LIMIT) {
    reasons.push(
      `never-attempted: ${observation.neverAttemptedRemaining ?? 'an unmeasured number of'} proposed completion(s) ` +
        `have waited ${neverAttemptedStreak} consecutive fires without ever being attempted (limit ${NEVER_ATTEMPTED_WAIT_FIRES_LIMIT}); ` +
        'a fresh close is not being reached, or the row cannot be read',
    );
  }
  if (floorRejectedStreak >= FLOOR_REJECTED_CONSECUTIVE_FIRES_LIMIT) {
    reasons.push(
      `floor-rejected: the reconciler proved settled but the SQL authority floor kept proposed, on ${floorRejectedStreak} ` +
        `consecutive measured fires (limit ${FLOOR_REJECTED_CONSECUTIVE_FIRES_LIMIT}); the TS proof and the floor disagree`,
    );
  }
  if (lookupUnavailableStreak >= LOOKUP_UNAVAILABLE_CONSECUTIVE_FIRES_LIMIT) {
    reasons.push(
      `lookup-unavailable: the exact-tree lookup returned nothing for ` +
        `${observation.outcome === 'completed' ? count(observation.lookupUnavailable) : 'an unmeasured number of'} ` +
        `row(s) on ${lookupUnavailableStreak} consecutive measured fires (limit ${LOOKUP_UNAVAILABLE_CONSECUTIVE_FIRES_LIMIT}); ` +
        'those closes are skipped, not settled — check git ls-tree latency and the 5s lookup timeout',
    );
  }

  const completed = observation.outcome === 'completed' ? observation : null;
  return {
    observed_at: new Date(nowMs).toISOString(),
    last_outcome: observation.outcome,
    inspected: completed ? completed.inspected : null,
    upgraded: completed ? completed.upgraded : null,
    residual: completed ? completed.residual : null,
    unreadable: completed ? completed.unreadable : null,
    floor_rejected: completed ? completed.floorRejected : null,
    lookup_unavailable: completed ? count(completed.lookupUnavailable) : null,
    never_attempted_remaining: observation.neverAttemptedRemaining,
    consecutive_never_attempted_fires: neverAttemptedStreak,
    consecutive_floor_rejected_fires: floorRejectedStreak,
    consecutive_lookup_unavailable_fires: lookupUnavailableStreak,
    verdict: reasons.length > 0 ? 'failing' : 'ok',
    reasons,
  };
}

export interface RecordCompletionSettlementHealthDeps {
  /** Reads the previously persisted `completion_settlement_health` value (any shape, or null). */
  readPrevious: () => Promise<unknown>;
  /** Persists the next health — the git-sync routine's existing top-level metadata merge. */
  write: (patch: { [COMPLETION_SETTLEMENT_HEALTH_KEY]: CompletionSettlementHealth }) => Promise<void>;
  now?: () => number;
  warn?: (message: string) => void;
}

/**
 * Persist one fire's observation and return the verdict. Warns ONCE per ok→failing edge
 * (a chronic failure must not re-broadcast every fire), never throws on a read failure —
 * an unreadable previous value simply restarts the streaks.
 */
export async function recordCompletionSettlementHealth(
  observation: SettlementFireObservation,
  deps: RecordCompletionSettlementHealthDeps,
): Promise<CompletionSettlementHealth> {
  const previous = await deps.readPrevious().catch(() => null);
  const next = advanceCompletionSettlementHealth(previous, observation, (deps.now ?? Date.now)());
  await deps.write({ [COMPLETION_SETTLEMENT_HEALTH_KEY]: next });
  const wasFailing =
    previous !== null && typeof previous === 'object' && (previous as Record<string, unknown>).verdict === 'failing';
  if (next.verdict === 'failing' && !wasFailing) {
    (deps.warn ?? console.warn)(`[git-sync-completion-settlement] standing guard FAILING: ${next.reasons.join(' | ')}`);
  }
  return next;
}
