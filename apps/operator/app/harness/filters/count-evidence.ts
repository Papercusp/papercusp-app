/**
 * CountEvidence makes the population behind a displayed count explicit.
 *
 * A number without one of these variants is not safe to present as a total:
 * it may be a loaded page, a lower bound, or the residue of a failed summary.
 * Keep this type small and transport-agnostic so list panels, filter facets,
 * and count-label helpers can share the same contract.
 */

export type UnknownCountReason = 'loading' | 'updating' | 'failed' | 'unavailable';

export type CountEvidence =
  | {
      /** `count` is exact for the complete declared population. */
      kind: 'corpus';
      count: number;
      /**
       * When present, `count` is an exact matched count and `total` is the
       * exact size of the same corpus. When absent, `count` is the corpus total.
       */
      total?: number;
      /** Human-readable population name; defaults to "full corpus". */
      population?: string;
    }
  | {
      /** `count` is exact only inside the explicitly named window. */
      kind: 'window';
      count: number;
      /** A visible/audible name such as "latest 300 events". */
      window: string;
      /** Exact window denominator when `count` is filtered inside the window. */
      windowTotal?: number;
      /** Optional independent exact corpus total for "showing N of M" copy. */
      corpusTotal?: number;
    }
  | {
      /** `count` is a trustworthy lower bound, never an exact total. */
      kind: 'floor';
      count: number;
      /** Human-readable population name; defaults to "records". */
      population?: string;
    }
  | {
      /** No trustworthy writer completed; suppress numeric fallback. */
      kind: 'unknown';
      reason: UnknownCountReason;
    };

export function assertCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

/** Grouped, environment-independent digits for every count surface. */
export function formatCountNumber(value: number): string {
  assertCount(value, 'count');
  return value.toLocaleString('en-US');
}

/**
 * Accessible population description for facet-option counts. The option's own
 * number is rendered elsewhere; this supplies the scope that number measures.
 */
export function countEvidenceScopeText(evidence: CountEvidence): string {
  switch (evidence.kind) {
    case 'corpus':
      assertCount(evidence.count, 'count');
      if (evidence.total != null) assertCount(evidence.total, 'total');
      return evidence.population ?? 'the full corpus';
    case 'window': {
      assertCount(evidence.count, 'count');
      if (evidence.windowTotal != null) assertCount(evidence.windowTotal, 'windowTotal');
      if (evidence.corpusTotal != null) assertCount(evidence.corpusTotal, 'corpusTotal');
      const corpus = evidence.corpusTotal == null
        ? ''
        : `; ${formatCountNumber(evidence.corpusTotal)} in the full corpus`;
      return `${evidence.window}${corpus}`;
    }
    case 'floor':
      assertCount(evidence.count, 'count');
      return `an incomplete population of at least ${formatCountNumber(evidence.count)} ${evidence.population ?? 'records'}`;
    case 'unknown':
      return evidence.reason === 'updating'
        ? 'a population whose count is updating'
        : evidence.reason === 'loading'
          ? 'a population whose count is loading'
          : 'a population whose count is unavailable';
  }
}
