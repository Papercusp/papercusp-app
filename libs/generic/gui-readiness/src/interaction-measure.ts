/**
 * Why a begin/end interaction timing DID NOT produce a measure — the four-plus
 * causes that otherwise share one signature.
 *
 * THE DEFECT CLASS THIS KILLS. A User-Timing interaction is instrumented as a
 * pair: a `begin` writes a `<name>:start` mark on the triggering gesture, and a
 * `end` — usually in a DIFFERENT component, on the settle point — consumes that
 * mark and emits the `<name>` measure. A driver then waits for the measure and
 * asserts it against a budget.
 *
 * When the measure never appears, the wait can only report the SYMPTOM: "no
 * <name> measure emitted within Nms". That one sentence is emitted identically
 * whether
 *
 *   1. the gesture never reached the handler (bad selector, disabled control,
 *      an overlay eating the click) — nothing was ever timed;
 *   2. the gesture fired but the settle SURFACE never appeared (the popup never
 *      opened, the route never changed) — a wiring/state defect;
 *   3. the surface appeared but never rendered CONTENT (the fetch hung, the
 *      renderer threw) — a real load defect, and the one worth a budget;
 *   4. content rendered but the settle hook never ran (the `end` call site is
 *      missing from THIS mount context, or it ran before the begin and no-oped)
 *      — an instrumentation defect that reads as "never regressed" forever;
 *   5. everything worked and is simply SLOWER than the wait window — the only
 *      case that is actually a performance regression.
 *
 * Causes 1–4 are all bugs in different components, and a driver that reports the
 * symptom sends the reader to debug whichever one they happened to suspect.
 * (Measured: cause 4 is the one that hides, because a `end` that no-ops without
 * a matching start emits NOTHING, which is indistinguishable from a fast path
 * that was never exercised.)
 *
 * So: this module takes what the driver can see at the moment the wait expires
 * and names WHICH of them happened. It is a pure function — no DOM, no timers,
 * no framework — so it is testable where the driver itself is not.
 *
 * ORDERING IS THE WHOLE DESIGN. The checks run trigger → begin → surface →
 * content → hook, each strictly downstream of the last, because a later stage
 * cannot be judged on a run where an earlier one never happened. Judging
 * "content missing" on a run whose popup never opened reports the wrong defect
 * with full confidence.
 */

/** What the driver observed when the measure-wait expired. */
export interface InteractionMeasureObservation {
  /** `performance.getEntriesByName(name, 'measure').length`. */
  measureCount: number;
  /** Whether a `<name>:start` mark exists NOW (the `end` consumes it on success). */
  startMarkPresent: boolean;
  /**
   * Age of the newest start mark (`performance.now() - mark.startTime`), or null
   * when absent. Distinguishes a start left by THIS gesture from a stale one an
   * earlier interaction abandoned.
   */
  startMarkAgeMs: number | null;
  /**
   * The instrument's own stale-start threshold. A start older than this is
   * discarded by `end` rather than measured, so a mark past it cannot be
   * attributed to the gesture under test.
   */
  staleStartMs: number;
  /** Whether the element the gesture targeted was found and actioned. */
  triggerFound: boolean;
  /** Whether the container whose render ends the interaction is in the document. */
  settleSurfacePresent: boolean;
  /** Whether that container has rendered real content (not just a shell/spinner). */
  settleContentPresent: boolean;
  /** Wall time from the gesture to this observation. */
  elapsedMs: number;
}

export type InteractionMeasureVerdict =
  /** The measure exists — nothing to diagnose. */
  | 'measured'
  /** The gesture had no target: nothing was timed, and no later stage is judgeable. */
  | 'trigger-missing'
  /** The gesture landed but no start mark followed: the `begin` call site never ran. */
  | 'begin-never-fired'
  /** A start mark exists but predates this gesture (past the stale threshold). */
  | 'start-stale'
  /** Timing began; the settle surface never appeared at all. */
  | 'settle-surface-never-appeared'
  /** The surface appeared but never rendered content — the real load defect. */
  | 'settle-content-never-rendered'
  /** Content rendered, yet no measure: the `end` call site never ran here. */
  | 'settle-hook-never-fired';

export interface InteractionMeasureDiagnosis {
  verdict: InteractionMeasureVerdict;
  /** True only for `measured`. */
  ok: boolean;
  /**
   * Where to look — the component/stage responsible for THIS verdict, so the
   * message points at one place instead of the whole chain.
   */
  suspect: string;
  /** One line, safe to put straight into a driver's failure message. */
  detail: string;
}

const SUSPECTS: Record<InteractionMeasureVerdict, string> = {
  'measured': 'nothing — the measure was emitted',
  'trigger-missing': 'the driver selector, or the surface that renders the trigger',
  'begin-never-fired': "the trigger's own handler (the beginInteraction call site)",
  'start-stale': 'an earlier abandoned interaction; this gesture never began one',
  'settle-surface-never-appeared': 'the state/route change the trigger dispatches',
  'settle-content-never-rendered': "the settle surface's data load or renderer",
  'settle-hook-never-fired': "the endInteraction call site in THIS mount context",
};

/**
 * Name the cause of a missing interaction measure.
 *
 * Never throws and never guesses past the evidence: each verdict is decided only
 * from observations upstream of it, so a verdict is always attributable to a
 * stage the observation actually covers.
 */
export function classifyInteractionMeasure(
  observation: InteractionMeasureObservation,
): InteractionMeasureDiagnosis {
  const {
    measureCount,
    startMarkPresent,
    startMarkAgeMs,
    staleStartMs,
    triggerFound,
    settleSurfacePresent,
    settleContentPresent,
    elapsedMs,
  } = observation;

  const say = (verdict: InteractionMeasureVerdict, detail: string): InteractionMeasureDiagnosis => ({
    verdict,
    ok: verdict === 'measured',
    suspect: SUSPECTS[verdict],
    detail,
  });

  // A measure settles everything, whatever else is or is not on the page.
  if (measureCount > 0) {
    return say('measured', `${measureCount} measure(s) present after ${Math.round(elapsedMs)}ms`);
  }

  // Stage 1 — did the gesture have a target? Nothing downstream is judgeable
  // without this, so it is decided first and alone.
  if (!triggerFound) {
    return say(
      'trigger-missing',
      'the trigger element was never found, so no interaction was started — every later stage is unjudged, not passing',
    );
  }

  // Stage 2 — did the begin run? The `end` CONSUMES the mark on success, but
  // there is no measure here, so an absent mark means it was never written.
  const staleMark =
    startMarkPresent && startMarkAgeMs !== null && startMarkAgeMs > staleStartMs;

  if (!startMarkPresent) {
    return say(
      'begin-never-fired',
      `the trigger was actioned but no start mark exists ${Math.round(elapsedMs)}ms later — the gesture did not reach the beginInteraction call site (wrong target, or the handler is not bound on this path)`,
    );
  }

  if (staleMark) {
    return say(
      'start-stale',
      `the only start mark is ${Math.round(startMarkAgeMs as number)}ms old (past the ${staleStartMs}ms stale threshold), so it predates this gesture and would be discarded rather than measured`,
    );
  }

  // Stage 3 — timing began. Did the surface that ends it ever appear?
  if (!settleSurfacePresent) {
    return say(
      'settle-surface-never-appeared',
      `timing began but the settle surface never entered the document within ${Math.round(elapsedMs)}ms — the trigger's state change did not take effect`,
    );
  }

  // Stage 4 — the surface is there. Did it render anything?
  if (!settleContentPresent) {
    return say(
      'settle-content-never-rendered',
      `the settle surface mounted but rendered no content within ${Math.round(elapsedMs)}ms — its data load or renderer never completed (this is the load defect a budget is meant to catch)`,
    );
  }

  // Stage 5 — content is on screen and still no measure: the end never ran.
  return say(
    'settle-hook-never-fired',
    `content rendered within ${Math.round(elapsedMs)}ms but no measure was emitted — the endInteraction call site did not run in this mount context (or ran before the begin and no-oped)`,
  );
}

/**
 * What a driver saw when ONE attempt's settle-wait expired — before it decides
 * whether to move on to another candidate subject.
 *
 * THE DEFECT CLASS THIS KILLS. A driver that retries across candidate subjects
 * (sidebar rows, fixtures) must discard attempts that never exercised the timed
 * path (a plan that 404s, a click that never began timing). Treating EVERY
 * expired wait that way is wrong: an attempt that began timing AND dispatched its
 * timed work, then simply did not finish inside the window, is the slowest
 * possible observation of the interaction. Discarding it retries onto the next
 * subject until one is fast enough, and a run whose every attempt was slow
 * reports "unmeasurable" instead of "slow". Either way the sample set is biased
 * toward a pass. (Measured 2026-09-26, P-007: 3 of 10 native runs stalled >8s
 * after dispatch and were each reported UNMEASURABLE rather than as breaches.)
 */
export interface AttemptTimeoutObservation {
  /** Whether a `<name>:start` mark exists at the observation. */
  startMarkPresent: boolean;
  /** Age of the newest start mark, or null when absent. */
  startMarkAgeMs: number | null;
  /** The instrument's stale-start threshold (see InteractionMeasureObservation). */
  staleStartMs: number;
  /** Phase names already marked for this interaction (e.g. `request-started`). */
  phasesSeen: readonly string[];
  /**
   * The phase that proves the attempt dispatched its timed work — after it, the
   * subject is known to be on the path the budget covers.
   */
  dispatchPhase: string;
  /**
   * Text of a terminal, non-loading placeholder (not-found, server error), or
   * null. A terminal placeholder means the subject cannot complete here at all.
   */
  terminalPlaceholder: string | null;
}

export interface AttemptTimeoutDiagnosis {
  /**
   * `slow` — the attempt is a real (breaching) sample and must be recorded, never
   * retried away. `void` — the attempt never exercised the timed path; trying
   * another subject is correct.
   */
  verdict: 'slow' | 'void';
  /** One line naming why. */
  reason: string;
}

/**
 * Decide whether an expired settle-wait is a slow sample or a void attempt.
 * Pure; never throws. Every `slow` verdict requires positive evidence that
 * timing began for THIS gesture and its timed work was dispatched.
 */
export function classifyAttemptTimeout(
  observation: AttemptTimeoutObservation,
): AttemptTimeoutDiagnosis {
  const {
    startMarkPresent,
    startMarkAgeMs,
    staleStartMs,
    phasesSeen,
    dispatchPhase,
    terminalPlaceholder,
  } = observation;

  if (terminalPlaceholder !== null && terminalPlaceholder.trim() !== '') {
    return {
      verdict: 'void',
      reason: `the subject reached a terminal placeholder (${JSON.stringify(terminalPlaceholder.trim().slice(0, 80))}), so it cannot complete here`,
    };
  }
  if (!startMarkPresent || startMarkAgeMs === null) {
    return {
      verdict: 'void',
      reason: 'no start mark exists, so this attempt never began timing',
    };
  }
  if (startMarkAgeMs > staleStartMs) {
    return {
      verdict: 'void',
      reason: `the start mark is ${Math.round(startMarkAgeMs)}ms old (past the ${staleStartMs}ms stale threshold), so it cannot belong to this attempt`,
    };
  }
  if (!phasesSeen.includes(dispatchPhase)) {
    return {
      verdict: 'void',
      reason: `timing began but the "${dispatchPhase}" phase never marked, so the timed work was not dispatched`,
    };
  }
  return {
    verdict: 'slow',
    reason: `timing began and "${dispatchPhase}" marked, yet no measure after ${Math.round(startMarkAgeMs)}ms — a slow sample, not a void attempt`,
  };
}

/**
 * Render a diagnosis as a driver failure message: the symptom, then the named
 * cause and where to look.
 */
export function describeInteractionMeasureFailure(
  interactionName: string,
  waitMs: number,
  diagnosis: InteractionMeasureDiagnosis,
): string {
  return [
    `no "${interactionName}" measure emitted within ${waitMs}ms of the trigger`,
    `cause: ${diagnosis.verdict} — ${diagnosis.detail}`,
    `look at: ${diagnosis.suspect}`,
  ].join('\n  ');
}
