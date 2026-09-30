export interface SerialLeg {
  name: string;
  ms: number;
}

export interface SerialPhaseSummary {
  legs: number;
  /** Legacy marker name: summed task duration (serial-equivalent work), not scheduler wall time. */
  serialMs: number;
  longestMs: number;
  longestName: string;
  /**
   * serialMs / longestMs — an UPPER BOUND on perfect overlap versus serial execution, never an
   * achieved or forecast speedup. It ignores host contention and scheduler shape. 1 when there
   * is a single leg or every leg measured 0ms.
   */
  ceilingX: number;
  /**
   * The phase's ACTUAL elapsed wall, first leg start to last leg end, when the caller measured
   * it. `undefined` — never 0 — when it did not: a missing measurement must stay visibly missing,
   * because `wallMs: 0` would be indistinguishable from a phase that genuinely took no time, and
   * would render an `achievedX` of 0.00x that reads like a real result. Same reasoning as
   * summarizeSerialPhase returning null for an empty leg set rather than a row of zeros.
   */
  wallMs?: number;
  /**
   * serialMs / wallMs — the MEASURED overlap the scheduler actually achieved, as against the
   * `ceilingX` bound above. Present exactly when `wallMs` is. The gap between the two is what
   * says whether a run is short of concurrency or short of nothing (P-005/D-032).
   */
  achievedX?: number;
  /** Every leg, slowest first. */
  slowest: SerialLeg[];
}

/** Measured phase wall, when the caller has one. Omit it rather than passing a placeholder. */
export interface SerialPhaseOptions {
  wallMs?: number;
}

/** `null` for an empty or wholly-invalid leg set, so a zero-task run emits nothing. */
export function summarizeSerialPhase(
  legs: SerialLeg[],
  opts?: SerialPhaseOptions,
): SerialPhaseSummary | null;

export function formatSerialPhaseMarker(summary: SerialPhaseSummary): string;

export function formatSerialPhaseSummary(
  legs: SerialLeg[],
  opts?: SerialPhaseOptions & { topN?: number },
): string[];
