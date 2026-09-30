/**
 * Classify the health of an instrument INJECTED into a live document.
 *
 * WHY THIS EXISTS (WI-38449): a perf harness that injects a measurement bundle
 * into a running webview has four genuinely different ways to come back with
 * nothing — and, injected naively, all four produce the SAME observation:
 *
 *     { ready: false, metrics: null, errors: [] }
 *
 * The document was replaced under the probe; the bundle threw while its library
 * initialised; the script element never executed at all; the payload ran but
 * never finished registering. One signature, four remedies — so whichever one
 * the message happens to name, it sends the next reader to the wrong place. The
 * desktop suite's web-vitals probe reported "the bundle did not execute or its
 * observers failed to register", which describes two of the four and is silent
 * about the other two.
 *
 * That is the same defect class the probe itself was written to kill one level
 * down (a `{}` that meant both "idle page" and "instrument never loaded"), and
 * the fix is the same one: DO NOT add another assertion on the same value —
 * make each broken state a DIFFERENT VALUE. This module is that discrimination,
 * kept pure so it can be tested; the caller supplies only observations.
 *
 * ── THE TWO SENTINELS, AND WHY BOTH ──────────────────────────────────────────
 * The caller wraps the payload so that:
 *
 *   - `injectedSentinel` is set as the FIRST statement, OUTSIDE the try. It
 *     answers "did the script element execute at all", which is unanswerable
 *     from the payload's own state because a bundler hoists library code ABOVE
 *     the payload's first line. (Measured: web-vitals 5.3.0 bundles to 9,875
 *     bytes with the payload's first assignment at offset 9,412 — 95% of the
 *     bundle runs before anything observable is set.)
 *   - `readySentinel` is set as the LAST statement. It answers "did
 *     registration COMPLETE", not merely "did the script start".
 *
 * A throw between them is captured into `fatal` rather than escaping, because an
 * uncaught error inside an injected inline `<script>` goes to the page's error
 * handler and is invisible to the driver that injected it.
 *
 * ── WHY REPLACEMENT IS CHECKED FIRST ─────────────────────────────────────────
 * A replaced document takes the sentinels with it, so EVERY other reading is
 * simultaneously true and meaningless: the sentinels are absent because the
 * window they lived in is gone, not because anything about the payload failed.
 * Judging the payload on a document it never ran in is a misattribution, so
 * replacement is decided before the payload is judged at all.
 */

/** How an injected instrument ended up. Each value has a DIFFERENT remedy. */
export type InjectedInstrumentState =
  /** Registered and observable. The only healthy value. */
  | 'ready'
  /** The document was replaced; the payload's fate is UNKNOWN, not failed. */
  | 'replaced'
  /** The payload threw while executing. `fatal` names it. */
  | 'threw'
  /** The script element never ran (blocked, stripped, or no document to host it). */
  | 'never-executed'
  /** It ran and did not throw, but never finished registering. */
  | 'incomplete';

export interface InjectedInstrumentObservation {
  /**
   * Identity of the document at injection time, or null when the caller could
   * not read one. Null disables the replacement verdict rather than faking it —
   * see {@link InjectedInstrumentVerdict.replacementChecked}.
   */
  docTokenAtInjection: string | null;
  /** Identity read back after settling. Null when absent (a fresh document). */
  docTokenAfterSettle: string | null;
  /** The FIRST-statement sentinel: the script element executed. */
  injectedSentinel: boolean;
  /** Message captured from a throw inside the injected payload, if any. */
  fatal: string | null;
  /** The LAST-statement sentinel: registration completed. */
  readySentinel: boolean;
}

export interface InjectedInstrumentVerdict {
  state: InjectedInstrumentState;
  /** Why, in terms a reader can act on. Never empty. */
  reason: string;
  /**
   * Whether replacement could be RULED OUT. False means the caller supplied no
   * injection-time token, so `state` describes the payload on the assumption the
   * document survived — an assumption nothing here verified. Reported rather
   * than hidden: an unchecked assumption presented as a verdict is how the
   * original bug survived.
   */
  replacementChecked: boolean;
}

/**
 * PURE: observations → verdict. No IO, no clock.
 *
 * Order is load-bearing: replacement, then throw, then never-executed, then
 * incomplete. Each earlier state makes the later readings unreliable, so testing
 * them in any other order reports a downstream symptom as the cause.
 */
export function classifyInjectedInstrument(
  obs: InjectedInstrumentObservation,
): InjectedInstrumentVerdict {
  const replacementChecked = obs.docTokenAtInjection !== null;

  if (replacementChecked && obs.docTokenAfterSettle !== obs.docTokenAtInjection) {
    const now = obs.docTokenAfterSettle ?? '(absent)';
    return {
      state: 'replaced',
      replacementChecked,
      reason:
        `the document was REPLACED after injection (${obs.docTokenAtInjection} → ${now}) — ` +
        `the instrument's state died with the old window, so this run says NOTHING about ` +
        `whether the instrument works. A reload, a navigation, or a crashed webview took it.`,
    };
  }

  if (obs.fatal !== null && obs.fatal !== '') {
    return {
      state: 'threw',
      replacementChecked,
      reason: `the injected payload THREW while executing: ${obs.fatal}`,
    };
  }

  if (!obs.injectedSentinel) {
    return {
      state: 'never-executed',
      replacementChecked,
      reason:
        'the injected script element never executed — its first statement did not run. ' +
        'Suspect the injection mechanism (a content-security policy, a stripped script ' +
        'node, or no document to host it), NOT the payload.',
    };
  }

  if (!obs.readySentinel) {
    return {
      state: 'incomplete',
      replacementChecked,
      reason:
        'the payload started and did not throw, but never reached its completion ' +
        'sentinel — registration stopped partway.',
    };
  }

  return {
    state: 'ready',
    replacementChecked,
    reason: 'the instrument registered and is observable',
  };
}

/**
 * True when the verdict means "the instrument is not usable".
 *
 * `replaced` counts: the run produced no trustworthy reading. It is a DIFFERENT
 * cause from a broken instrument and must stay a different `state`, but a caller
 * asking "can I trust these numbers?" gets the same answer for both.
 */
export function isInstrumentUnusable(verdict: InjectedInstrumentVerdict): boolean {
  return verdict.state !== 'ready';
}
