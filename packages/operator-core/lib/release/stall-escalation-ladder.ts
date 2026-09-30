/**
 * Gate-stall escalation LADDER — the decision half (WI-42116, ruling
 * green-main-fast-2026-08-25 D-022).
 *
 * ## The defect this replaces
 *
 * `release-actions.ts` escalates a gate stall on the crossing edge
 * `(stalledByCount || stalledByAge) && !stallAlerted`. `stallAlerted` is then CARRIED on
 * every subsequent red and reset ONLY by a green. The ladder therefore has exactly ONE
 * rung: the alarm fires at `stallReds` (default 3) and never fires again, however deep or
 * long the streak runs.
 *
 * Measured on papercusp 2026-08-26: `consecutiveReds: 43`, `stallAlerted: true`, last green
 * 2026-08-20T20:55:17Z → observed 2026-08-25T23:47:58Z = 122.9 h / 5.12 days of unbroken
 * red, on ONE alert raised on day one. Reds #4–#43 were silent. That silence is why a
 * LIVELOCKED gate read as "already alerted, someone's on it" for five days.
 *
 * ## ⚠ Why the obvious fix is wrong
 *
 * EI-7472 (resolved) is the REASON the one-shot exists: "watchdogAlerted dedup flag is
 * clobbered every red tick → fleet re-spammed the STALLED severe-event ~hourly". A naive
 * "re-alert while still red" REINTRODUCES it. The one-shot is a fix, over-corrected — not
 * an oversight. So this ladder is BOUNDED and SUPER-LINEAR by construction: rungs grow
 * geometrically, which makes the alert count O(log(stall depth)) rather than O(ticks).
 * `laddersAreSparse` in the test file pins that property directly.
 *
 * ## Why there are THREE axes
 *
 * A count-only ladder would ALSO go silent on the exact gate this exists to catch. In
 * `release-actions.ts`, `carryStreak = recordOnly || alreadyCountedPending` means
 * `consecutiveReds` does NOT increment on withheld / record-only ticks. A livelocked gate
 * (every red withheld as `candidate-fossil`, so no verdict ever publishes) can therefore
 * sit at a FIXED red count indefinitely while time runs on. papercusp was in precisely
 * that state. So the ladder escalates on whichever axis moves: red COUNT or stall AGE.
 *
 * P-003 adds the third axis: FIXER SUCCESSION. A serialized frozen repair can be correctly
 * excluded from the red count (`repair-in-progress` is a no-verdict hold) while its targeted
 * fixer is confirmed dead or never materialized. That is neither a deeper red count nor the
 * age of the whole gate — it is an independently actionable ownership failure. Giving it its
 * own age series makes the first dead/absent fixer loud without reintroducing per-tick spam.
 * Each axis therefore carries its own independent high-water mark.
 *
 * ## Scope — read before wiring
 *
 * This governs the HUMAN-NOTIFY leg ONLY. The `gate-red-streak:<harness>` condition and
 * the claimable work-item it mints keep WI-6228's `oneShot:true` semantics untouched:
 * re-NOTIFY, never re-mint, never re-open the condition. Separating those two legs is
 * exactly what wiring this ladder achieved.
 *
 * PURE, AND WIRED — do not wire it again. The exported functions still perform no I/O, but
 * this module IS imported: WI-42116 (done) landed the call site, and
 * `harness/routines/release-actions.ts` calls `decideStallNotification` +
 * `describeLadderPosition` on the gate-stall tick. There is exactly ONE production call
 * site and there must remain exactly one — a second would notify the owner twice per rung,
 * reintroducing the EI-7472 re-spam this ladder's bounded, super-linear design exists to
 * avoid.
 *
 * ⚠ This header previously described the module as still inert and its wiring as a
 * pending follow-up, for hours after that wiring landed (EI-21528303638863879). That is a
 * double-wire trap rather than a cosmetic lag: a reader who checks WI-42116, finds it
 * `done`, and reads this module as still inert concludes the item was closed WITHOUT its
 * wiring — the exact inverse of the truth. Wiring status is a fact the CODE owns, so it is
 * now pinned by `doc-claims/stall-ladder-wiring-status.test.ts` instead of being
 * hand-maintained here.
 */

/**
 * Geometric growth factor between rungs. Base 3 over the shipped defaults
 * (`stallReds: 3`, `stallAgeMs: 6h`) yields count rungs 3, 9, 27, 81, … and age rungs
 * 6h, 18h, 54h, 162h, … — about 3 alerts across the measured 43-red / 122.9-hour stall,
 * against 1 today and ~120 under a per-tick repeat.
 */
export const STALL_LADDER_GROWTH = 3;

/** A stall is escalated on whichever axis crosses a new rung first. */
export type StallLadderAxis = 'fixer' | 'count' | 'age';

/**
 * The persisted high-water marks. Both are the value AT WHICH the last notification was
 * raised, NOT a rung index — storing the threshold itself keeps the record readable and
 * survives a config change to `stallReds` / `stallAgeMs` without re-alerting spuriously.
 */
export interface StallLadderMarks {
  /** Deepest red count already notified. Absent/null ⇒ never notified on this axis. */
  stallAlertedAtReds?: number | null;
  /** Longest stall age (ms) already notified. Absent/null ⇒ never notified on this axis. */
  stallAlertedAtAgeMs?: number | null;
  /** Longest dead/absent fixer succession gap already notified for the CURRENT attempt. */
  stallAlertedAtFixerAgeMs?: number | null;
  /** Attempt identity paired with the fixer-age mark; a replacement starts a new series. */
  stallFixerSuccessionKey?: string | null;
  /**
   * The legacy boolean. Back-compat: `true` with no marks means the OLD one-shot already
   * fired, so the marks are seeded at the first rung of each axis rather than re-alerting
   * immediately for a stall that was already announced.
   */
  stallAlerted?: boolean | null;
}

export interface StallLadderInput {
  /** `gate_health.consecutiveReds` for this tick. */
  consecutiveReds: number;
  /** Milliseconds since the last real green, or null when unknown. */
  stallAgeMs: number | null;
  /** `releaseCheckpointConfig().stallReds` — the first count rung. */
  stallRedsThreshold: number;
  /** `releaseCheckpointConfig().stallAgeMs` — the first age rung. */
  stallAgeThresholdMs: number;
  /** Age of the current confirmed-dead/absent fixer succession gap, or null when covered. */
  fixerSuccessionAgeMs?: number | null;
  /** First fixer-succession rung. Omit when no queue/liveness observation was available. */
  fixerSuccessionThresholdMs?: number;
  /** Attempt identity for the fixer-succession observation. */
  fixerSuccessionKey?: string | null;
  /** The marks carried on `gate_health`. */
  marks: StallLadderMarks;
}

export interface StallLadderDecision {
  /** Raise a human notification on this tick? */
  shouldNotify: boolean;
  /** Which axis triggered it, or null when not notifying. */
  axis: StallLadderAxis | null;
  /** The rung crossed, in that axis's own units (reds, or ms). */
  rung: number | null;
  /** 0-based index of that rung in its geometric series. */
  rungIndex: number | null;
  /**
   * The marks to PERSIST after this tick. Always returned — including when not notifying —
   * so the caller can write back unconditionally and the back-compat seeding lands even on
   * a quiet tick.
   */
  marks: {
    stallAlertedAtReds: number | null;
    stallAlertedAtAgeMs: number | null;
    stallAlertedAtFixerAgeMs: number | null;
    stallFixerSuccessionKey: string | null;
  };
  /** Human-readable why, for the log line and for tests to assert against. */
  reason: string;
}

/**
 * Highest rung of the geometric series `first * growth^k` that is <= `value`, or null when
 * `value` has not reached `first`. Returns the rung's value and its index.
 *
 * Guards a non-finite / non-positive `first` by refusing to build a series at all — a
 * misconfigured threshold must go SILENT rather than divide-by-zero into an infinite loop
 * or alert on every tick.
 */
export function highestRungCrossed(
  value: number | null | undefined,
  first: number,
): { rung: number; index: number } | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (!Number.isFinite(first) || first <= 0) return null;
  if (value < first) return null;

  let rung = first;
  let index = 0;
  // Geometric, so this terminates in O(log(value / first)) iterations.
  while (rung * STALL_LADDER_GROWTH <= value) {
    rung *= STALL_LADDER_GROWTH;
    index += 1;
  }
  return { rung, index };
}

/**
 * Decide whether THIS tick should raise a human stall notification.
 *
 * Notifies at most ONCE per tick. When both axes have crossed a new rung on the same tick,
 * COUNT wins the attribution (it is the more specific signal — an age rung can be crossed
 * by a gate that is merely paused), but BOTH marks advance, so the quieter axis does not
 * fire a redundant alert on the following tick.
 */
export function decideStallNotification(input: StallLadderInput): StallLadderDecision {
  const {
    consecutiveReds,
    stallAgeMs,
    stallRedsThreshold,
    stallAgeThresholdMs,
    fixerSuccessionAgeMs,
    fixerSuccessionThresholdMs,
    fixerSuccessionKey,
    marks,
  } = input;

  const countRung = highestRungCrossed(consecutiveReds, stallRedsThreshold);
  const ageRung = highestRungCrossed(stallAgeMs, stallAgeThresholdMs);
  const fixerRung = highestRungCrossed(fixerSuccessionAgeMs, fixerSuccessionThresholdMs ?? Number.NaN);

  // Back-compat: a legacy `stallAlerted: true` with no marks means the old one-shot already
  // announced this stall. Seed each axis at its FIRST rung so we resume the ladder at the
  // second rung instead of immediately re-alerting for something already reported.
  const legacySeeded = marks.stallAlerted === true;
  const priorReds = marks.stallAlertedAtReds ?? (legacySeeded ? stallRedsThreshold : null);
  const priorAgeMs = marks.stallAlertedAtAgeMs ?? (legacySeeded ? stallAgeThresholdMs : null);
  // New axis, deliberately NOT seeded by the legacy one-shot. A gate can already have raised
  // its generic stall alarm and only later lose its fixer; suppressing that first succession
  // alarm would reproduce the five-hour silent gap this axis exists to close.
  const sameFixerAttempt =
    fixerSuccessionKey == null
      ? marks.stallFixerSuccessionKey == null
      : marks.stallFixerSuccessionKey === fixerSuccessionKey;
  const priorFixerAgeMs = sameFixerAttempt ? (marks.stallAlertedAtFixerAgeMs ?? null) : null;

  const countIsNew = countRung != null && (priorReds == null || countRung.rung > priorReds);
  const ageIsNew = ageRung != null && (priorAgeMs == null || ageRung.rung > priorAgeMs);
  const fixerIsNew = fixerRung != null && (priorFixerAgeMs == null || fixerRung.rung > priorFixerAgeMs);

  // Marks only ever advance — never regress. A green resets them by clearing the whole
  // gate_health block, which is the ONLY intended way back to null.
  const nextMarks: StallLadderDecision['marks'] = {
    stallAlertedAtReds: countRung != null ? Math.max(countRung.rung, priorReds ?? 0) : priorReds,
    stallAlertedAtAgeMs: ageRung != null ? Math.max(ageRung.rung, priorAgeMs ?? 0) : priorAgeMs,
    stallAlertedAtFixerAgeMs: null,
    stallFixerSuccessionKey: null,
  };
  if (fixerRung != null) {
    nextMarks.stallAlertedAtFixerAgeMs = Math.max(fixerRung.rung, priorFixerAgeMs ?? 0);
    nextMarks.stallFixerSuccessionKey = fixerSuccessionKey ?? null;
  } else if (fixerSuccessionKey != null || marks.stallFixerSuccessionKey != null) {
    // Explicitly clear a stale axis when the queue is healthy/absent.
    nextMarks.stallAlertedAtFixerAgeMs = null;
    nextMarks.stallFixerSuccessionKey = fixerSuccessionKey ?? null;
  }

  if (!fixerIsNew && !countIsNew && !ageIsNew) {
    const held =
      fixerRung != null || countRung != null || ageRung != null
        ? 'already notified at this rung — holding (EI-7472: never re-alert per tick)'
        : 'below the first rung on every measured axis';
    return {
      shouldNotify: false,
      axis: null,
      rung: null,
      rungIndex: null,
      marks: nextMarks,
      reason: held,
    };
  }

  // A dead/absent targeted fixer is the most specific actionable cause. Attribute a tick that
  // crosses several rungs at once to this axis, while `nextMarks` advances all crossed axes so
  // none produces a redundant follow-up alert.
  if (fixerIsNew) {
    return {
      shouldNotify: true,
      axis: 'fixer',
      rung: fixerRung!.rung,
      rungIndex: fixerRung!.index,
      marks: nextMarks,
      reason:
        `fixer succession gap ${fixerSuccessionAgeMs}ms crossed rung ${fixerRung!.rung}ms ` +
        `(index ${fixerRung!.index}) while the frozen repair remains awaiting-fixer`,
    };
  }

  if (countIsNew) {
    return {
      shouldNotify: true,
      axis: 'count',
      rung: countRung!.rung,
      rungIndex: countRung!.index,
      marks: nextMarks,
      reason: `red count ${consecutiveReds} crossed rung ${countRung!.rung} (index ${countRung!.index})`,
    };
  }

  return {
    shouldNotify: true,
    axis: 'age',
    rung: ageRung!.rung,
    rungIndex: ageRung!.index,
    marks: nextMarks,
    reason: `stall age ${stallAgeMs}ms crossed rung ${ageRung!.rung}ms (index ${ageRung!.index}) — count axis is not advancing (livelocked gate: carryStreak holds consecutiveReds fixed)`,
  };
}

/**
 * A one-line digest of WHERE in the ladder a stall currently sits, for the notification
 * body. Distinct from the decision above: this is descriptive, and safe to render on any
 * tick.
 */
export function describeLadderPosition(input: StallLadderInput): string {
  const countRung = highestRungCrossed(input.consecutiveReds, input.stallRedsThreshold);
  const ageRung = highestRungCrossed(input.stallAgeMs, input.stallAgeThresholdMs);
  const fixerRung = highestRungCrossed(input.fixerSuccessionAgeMs, input.fixerSuccessionThresholdMs ?? Number.NaN);
  const nextCount = (countRung?.rung ?? input.stallRedsThreshold / STALL_LADDER_GROWTH) * STALL_LADDER_GROWTH;
  const parts: string[] = [];
  parts.push(
    countRung != null
      ? `escalation ${countRung.index + 1} on the red-count axis (${input.consecutiveReds} reds); next at ${nextCount}`
      : `below the first red-count rung (${input.consecutiveReds}/${input.stallRedsThreshold})`,
  );
  if (ageRung != null) {
    const hrs = Math.round(ageRung.rung / 3_600_000);
    parts.push(`age axis past the ${hrs}h rung`);
  }
  if (fixerRung != null) {
    const mins = Math.round(fixerRung.rung / 60_000);
    parts.push(`fixer-succession axis past the ${mins}m rung`);
  }
  return parts.join('; ');
}
