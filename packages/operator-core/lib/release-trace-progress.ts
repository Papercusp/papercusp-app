/**
 * Progress certificate for an in-flight green-checkpoint run.
 *
 * ## What this exists to retire
 *
 * `release/checkpoint-run.ts` currently tells agents, in prose, to "judge liveness from
 * `current_phase` + `progress_at`" BY HAND. That manual judgement is made under time
 * pressure, from fields whose failure modes are not obvious, and its expensive direction is
 * asymmetric: a false `stalled` invites a manual `release:checkpoint-run`, which discards an
 * in-flight auto-refire rescue and costs a full ~55min suite. This module makes the same
 * judgement once, purely, with `unknown` as a first-class answer, so the ambiguity is
 * REPORTED rather than resolved by whichever way the reader happened to lean.
 *
 * It computes a verdict and NOTHING else. Turning a verdict into a recommended next verb is
 * a separate concern deliberately kept out of here (plan
 * `progress-certified-release-trace-2026-09-05` P-002), so the verdict stays falsifiable in
 * a unit test without booting a gate.
 *
 * ## The trap this module is mostly made of (D-003)
 *
 * `progressAtMs` FALLS BACK to `startedAtMs` when no heartbeat was measured — at
 * `git-pipeline-stats.ts:1156`, again in the pre-lock process-authority overlay at
 * `git-pipeline-stats.ts:1205` (`activeRun?.progressAtMs ?? authority.startedAtMs`), and in
 * `events/await/checkpoint-verified-wait.ts`. So `progressAtMs === startedAtMs` is
 * AMBIGUOUS: it means EITHER "started, no progress yet" OR "progress was never measured".
 * The naive rule `progressAtMs <= startedAtMs ⇒ stalled` therefore manufactures false stalls
 * in exactly the expensive direction, and EI-22129511435526580 already had to fix one
 * instance of that class one layer down. Here the equality yields `unknown`, never `stalled`.
 *
 * ## Evidence age is part of the verdict, not a footnote (D-005)
 *
 * When `activeSource` is absent the whole reading came from the cached derived-read, whose
 * `asOfAgeMs` "can be arbitrarily large (measured: 7h)"; that field's own documentation says
 * to treat an old cache-backed reading "as a HINT, not a measurement, in EITHER direction".
 * A verdict computed from a 7-hour-old snapshot but rendered with the confidence of a live
 * run-lock read would be this plan's own failure mode, one layer up. So every certificate
 * carries `evidenceAgeMs` WITH `evidenceAgeSource` naming which clock it came from, and an
 * age past the trust threshold caps the verdict at `unknown` regardless of the numbers
 * underneath.
 */

/** The three answers. `unknown` is a real answer, not a failure to compute one. */
export type ProgressVerdict = 'progressing' | 'stalled' | 'unknown';

/**
 * WHY the verdict is what it is. Callers key their wording off this, not off the verdict
 * alone: two `unknown`s with different bases need different things from the reader, and
 * collapsing them is how "we could not tell" gets read as "nothing is happening".
 */
export type ProgressBasis =
  /** No run is in flight, so there is no progress to certify. */
  | 'no-run'
  /** Cache-backed reading older than the trust threshold — a hint, not a measurement. */
  | 'evidence-too-old'
  /** The run already published its verdict; elapsed time now measures salvage, not deciding. */
  | 'verdict-published'
  /** A heartbeat strictly later than the run's start, recent enough to mean advancing. */
  | 'live-heartbeat'
  /** A heartbeat strictly later than the run's start, but older than the stall threshold. */
  | 'heartbeat-stale'
  /** `progressAtMs === startedAtMs` — the D-003 fallback collision. Never a stall. */
  | 'ambiguous-fallback'
  /** No heartbeat value at all. */
  | 'progress-unmeasured'
  /** The heartbeat is meaningfully in the future; the two clocks disagree. */
  | 'clock-skew';

/** Which clock `evidenceAgeMs` was measured against. `null` when no age applies. */
export type EvidenceAgeSource = 'heartbeat' | 'cache' | null;

/**
 * The subset of `gate.checkpointRunInFlight` this verdict reads.
 *
 * Structurally assignable FROM the real field, deliberately without importing it: the point
 * of a pure verdict is that a test can construct one of these by hand. Every property is
 * optional-or-nullable exactly as it is on the source, so an absent field stays UNKNOWN
 * here rather than defaulting to a number that reads like a measurement.
 */
export interface ProgressCertificateInput {
  active?: boolean;
  /** Present ONLY when a live authority answered; absent means the cache answered. */
  activeSource?: 'run-lock' | 'process-authority';
  /** Latest advancing heartbeat observed by the derived-read probe. */
  progressAtMs?: number | null;
  startedAtMs?: number | null;
  /** When the currently-active run published its verdict; `null` = still deciding. */
  verdictWrittenAtMs?: number | null;
  /** ms since the cache behind this reading was computed. */
  asOfAgeMs?: number | null;
  currentPhase?: string | null;
  elapsedSec?: number | null;
  /** The run is in its auto-refire re-triage window (D-004). */
  inRetriageWindow?: true;
}

export interface ProgressCertificate {
  verdict: ProgressVerdict;
  basis: ProgressBasis;
  /** Age of the observation the verdict actually rests on. `null` when none applies. */
  evidenceAgeMs: number | null;
  /** Which clock `evidenceAgeMs` came from — never leave the reader to guess. */
  evidenceAgeSource: EvidenceAgeSource;
  /** True when a live authority (run-lock / process-authority) answered this reading. */
  liveAuthority: boolean;
  /**
   * D-004 interlock, surfaced on every certificate including `stalled` ones. A caller may
   * never recommend a manual `release:checkpoint-run` while this is true: firing into the
   * re-triage window discards the in-flight rescue and costs a full suite.
   */
  inRetriageWindow: boolean;
  /** One line naming what WAS established and what was not. Safe to show a human verbatim. */
  detail: string;
}

export interface ProgressCertificateOptions {
  /**
   * Heartbeat age past which an otherwise-advancing run is called `stalled`.
   *
   * DEFAULT IS A JUDGEMENT, NOT A MEASUREMENT, and is labelled as such on purpose. A healthy
   * run can go quiet inside a single long test file, so too low a value re-creates the false
   * stall this module exists to prevent. Falsifier, and the reason P-004 exists: a run
   * observed healthy with a heartbeat gap wider than this means the value is too low.
   */
  stallThresholdMs?: number;
  /**
   * Cache age past which a non-live reading cannot support any verdict (D-005). Below this,
   * a cache-backed reading is still only ever a hint — it can support `unknown` and
   * `progressing`, never `stalled`, because a stale snapshot of an advancing run and a live
   * snapshot of a wedged one are the same bytes.
   */
  evidenceTrustMs?: number;
  /** Future-heartbeat tolerance before the two clocks are declared to disagree. */
  clockSkewToleranceMs?: number;
}

export const DEFAULT_STALL_THRESHOLD_MS = 600_000;
export const DEFAULT_EVIDENCE_TRUST_MS = 300_000;
export const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 60_000;

function certificate(
  verdict: ProgressVerdict,
  basis: ProgressBasis,
  detail: string,
  parts: {
    evidenceAgeMs?: number | null;
    evidenceAgeSource?: EvidenceAgeSource;
    liveAuthority: boolean;
    inRetriageWindow: boolean;
  },
): ProgressCertificate {
  return {
    verdict,
    basis,
    evidenceAgeMs: parts.evidenceAgeMs ?? null,
    evidenceAgeSource: parts.evidenceAgeSource ?? null,
    liveAuthority: parts.liveAuthority,
    inRetriageWindow: parts.inRetriageWindow,
    detail,
  };
}

/**
 * Certify whether an in-flight checkpoint run is advancing, wedged, or unjudgeable.
 *
 * Pure: every input including the clock is passed in. `nowMs` is REQUIRED rather than
 * defaulted to `Date.now()` so a test cannot accidentally assert against wall-clock time.
 */
export function certifyCheckpointProgress(
  input: ProgressCertificateInput | null | undefined,
  nowMs: number,
  options: ProgressCertificateOptions = {},
): ProgressCertificate {
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const evidenceTrustMs = options.evidenceTrustMs ?? DEFAULT_EVIDENCE_TRUST_MS;
  const clockSkewToleranceMs = options.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;

  const inRetriageWindow = input?.inRetriageWindow === true;
  const liveAuthority = input?.activeSource === 'run-lock' || input?.activeSource === 'process-authority';
  const base = { liveAuthority, inRetriageWindow };

  // No reading at all, or a reading that says no run is in flight. Deliberately NOT
  // `stalled`: nothing is wedged, there is simply nothing to certify, and the two need
  // different words from whoever reads this.
  if (input == null || input.active !== true) {
    return certificate(
      'unknown',
      'no-run',
      input == null
        ? 'No in-flight run reading was available, so no progress could be certified. This is an absent measurement, not an idle gate.'
        : 'No checkpoint run is in flight, so there is no progress to certify.',
      base,
    );
  }

  // D-005: a cache-backed reading past the trust window cannot support ANY verdict. Checked
  // before the numbers below, because those numbers are exactly what an old snapshot makes
  // look authoritative.
  if (!liveAuthority) {
    const cacheAge = input.asOfAgeMs;
    if (cacheAge == null || cacheAge > evidenceTrustMs) {
      return certificate(
        'unknown',
        'evidence-too-old',
        cacheAge == null
          ? 'No live authority answered and the cached reading carried no age, so its freshness is unknown and it cannot support a verdict in either direction.'
          : `No live authority answered and the cached reading is ${cacheAge}ms old (trust window ${evidenceTrustMs}ms), so it is a hint, not a measurement, in either direction.`,
        { ...base, evidenceAgeMs: cacheAge, evidenceAgeSource: cacheAge == null ? null : 'cache' },
      );
    }
  }

  const cacheAgeMs = liveAuthority ? null : (input.asOfAgeMs ?? null);

  // The run already DECIDED and is continuing into re-triage / longest-clean-prefix salvage
  // with its marker live. Checked before any staleness rule, because this is precisely the
  // case whose elapsed time looks overdue — "68 minutes and still no verdict" versus
  // "decided at 52 minutes, salvaging since". Firing a manual run here is the documented
  // harm. Note ABSENT means unknown, never "still deciding", so only a number qualifies.
  if (typeof input.verdictWrittenAtMs === 'number') {
    const sinceVerdict = nowMs - input.verdictWrittenAtMs;
    return certificate(
      'progressing',
      'verdict-published',
      `The run published its verdict ${sinceVerdict}ms ago and is continuing into re-triage/salvage. Elapsed time now measures salvage, not deciding — an overdue-looking runtime here is expected, not a wedge.`,
      { ...base, evidenceAgeMs: sinceVerdict, evidenceAgeSource: 'heartbeat' },
    );
  }

  const progressAtMs = input.progressAtMs;
  const startedAtMs = input.startedAtMs;

  if (progressAtMs == null) {
    return certificate(
      'unknown',
      'progress-unmeasured',
      'The reading carries no heartbeat at all, so whether the run is advancing was never measured. An absent heartbeat is not evidence of a stall.',
      { ...base, evidenceAgeMs: cacheAgeMs, evidenceAgeSource: cacheAgeMs == null ? null : 'cache' },
    );
  }

  // D-003, the whole point of this module. Every fallback site writes `startedAtMs` into
  // `progressAtMs` when nothing was measured, so equality cannot distinguish "just started"
  // from "never measured" — and BOTH readings are compatible with a perfectly healthy run.
  // Yielding `stalled` here is the false positive that costs a suite.
  if (startedAtMs != null && progressAtMs === startedAtMs) {
    return certificate(
      'unknown',
      'ambiguous-fallback',
      'The heartbeat equals the run start time. Every fallback site writes exactly that when no heartbeat was measured, so this means EITHER "started, no progress yet" OR "progress never measured" — it is not evidence of a stall.',
      { ...base, evidenceAgeMs: cacheAgeMs, evidenceAgeSource: cacheAgeMs == null ? null : 'cache' },
    );
  }

  // A heartbeat EARLIER than the start makes no sense on either reading; treat it as
  // unjudgeable rather than inventing a very large stall age from it.
  if (startedAtMs != null && progressAtMs < startedAtMs) {
    return certificate(
      'unknown',
      'clock-skew',
      `The heartbeat (${progressAtMs}) precedes the run start (${startedAtMs}), which no ordinary reading produces. The two timestamps disagree, so neither supports a verdict.`,
      { ...base, evidenceAgeMs: null, evidenceAgeSource: null },
    );
  }

  const heartbeatAgeMs = nowMs - progressAtMs;

  if (heartbeatAgeMs < -clockSkewToleranceMs) {
    return certificate(
      'unknown',
      'clock-skew',
      `The heartbeat is ${-heartbeatAgeMs}ms in the future, beyond the ${clockSkewToleranceMs}ms tolerance, so this reading's clock and ours disagree and the age cannot be trusted.`,
      { ...base, evidenceAgeMs: heartbeatAgeMs, evidenceAgeSource: 'heartbeat' },
    );
  }

  // A small negative age is ordinary clock jitter between two hosts; floor it rather than
  // report a negative duration.
  const age = Math.max(0, heartbeatAgeMs);

  if (age <= stallThresholdMs) {
    return certificate(
      'progressing',
      'live-heartbeat',
      `The run's heartbeat advanced past its start and was last seen ${age}ms ago, within the ${stallThresholdMs}ms threshold.`,
      { ...base, evidenceAgeMs: age, evidenceAgeSource: 'heartbeat' },
    );
  }

  // A cache-backed reading inside the trust window is still only a hint, and a stale
  // snapshot of an advancing run is byte-identical to a live snapshot of a wedged one. Only
  // a live authority may support `stalled`, which is the expensive verdict.
  if (!liveAuthority) {
    return certificate(
      'unknown',
      'evidence-too-old',
      `The heartbeat is ${age}ms old (past the ${stallThresholdMs}ms threshold) but no live authority answered, so an advancing run behind a stale cache cannot be distinguished from a wedged one. Re-read with a live authority before treating this as a stall.`,
      { ...base, evidenceAgeMs: age, evidenceAgeSource: 'heartbeat' },
    );
  }

  return certificate(
    'stalled',
    'heartbeat-stale',
    `A live authority answered and the run's heartbeat has not advanced for ${age}ms, past the ${stallThresholdMs}ms threshold.${
      inRetriageWindow
        ? ' The run is in its re-triage window: do NOT fire a manual checkpoint run, which would discard the in-flight rescue.'
        : ''
    }`,
    { ...base, evidenceAgeMs: age, evidenceAgeSource: 'heartbeat' },
  );
}
