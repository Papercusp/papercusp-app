/**
 * One count-label formatter for filterable panes.
 *
 * The input is deliberately a discriminated CountEvidence value rather than
 * `(shown, total, filtered)`. That old signature allowed a loaded-page length
 * to be paired with a corpus denominator and rendered as an exact match count.
 * Every branch below states its population in both visual and accessible copy.
 */

import {
  assertCount,
  countEvidenceScopeText,
  formatCountNumber,
  type CountEvidence,
} from './count-evidence';

export interface FilterCountLabel {
  /** Compact title/tab form. */
  title: string;
  /** Visible in-pane prose. */
  summary: string;
  /** Complete accessible wording; never relies on a tooltip for scope. */
  ariaLabel: string;
  /** Machine-readable evidence variant for guards and diagnostics. */
  evidence: CountEvidence['kind'];
}

function pluralNoun(noun: string, count: number): string {
  return `${noun}${count === 1 ? '' : 's'}`;
}

function unknownCopy(reason: Extract<CountEvidence, { kind: 'unknown' }>['reason']): string {
  if (reason === 'loading') return 'Count loading…';
  if (reason === 'updating') return 'Count updating…';
  return 'Count unavailable';
}

export function filterCountLabel(
  evidence: CountEvidence,
  noun = 'item',
): FilterCountLabel {
  if (evidence.kind === 'unknown') {
    const copy = unknownCopy(evidence.reason);
    return { title: '—', summary: copy, ariaLabel: copy, evidence: evidence.kind };
  }

  assertCount(evidence.count, 'count');

  if (evidence.kind === 'corpus') {
    const population = evidence.population ?? 'the full corpus';
    if (evidence.total != null) {
      assertCount(evidence.total, 'total');
      if (evidence.count > evidence.total) {
        throw new RangeError('corpus match count cannot exceed its total');
      }
      const title = `${formatCountNumber(evidence.count)} of ${formatCountNumber(evidence.total)}`;
      const summary = `${title} match`;
      return {
        title,
        summary,
        ariaLabel: `${summary} in ${population}`,
        evidence: evidence.kind,
      };
    }
    const title = formatCountNumber(evidence.count);
    const summary = `${title} ${pluralNoun(noun, evidence.count)}`;
    return {
      title,
      summary,
      ariaLabel: `${summary} in ${population}`,
      evidence: evidence.kind,
    };
  }

  if (evidence.kind === 'window') {
    if (evidence.windowTotal != null) {
      assertCount(evidence.windowTotal, 'windowTotal');
      if (evidence.count > evidence.windowTotal) {
        throw new RangeError('window match count cannot exceed its windowTotal');
      }
    }
    if (evidence.corpusTotal != null) assertCount(evidence.corpusTotal, 'corpusTotal');
    const count = formatCountNumber(evidence.count);
    // An unfiltered bounded page with a known corpus total is the common
    // paginated-list case. Say the relationship directly (P-008 Agent Runs)
    // rather than making the reader infer it from two clauses.
    if (evidence.windowTotal == null && evidence.corpusTotal != null) {
      if (evidence.count > evidence.corpusTotal) {
        throw new RangeError('window count cannot exceed corpusTotal');
      }
      const total = formatCountNumber(evidence.corpusTotal);
      const title = `${count} of ${total}`;
      const summary = `Showing ${title} ${pluralNoun(noun, evidence.corpusTotal)}`;
      return {
        title,
        summary,
        ariaLabel: `${summary} from ${evidence.window}`,
        evidence: evidence.kind,
      };
    }
    const title = evidence.windowTotal == null
      ? `${count} · ${evidence.window}`
      : `${count} of ${formatCountNumber(evidence.windowTotal)} · ${evidence.window}`;
    const summary = evidence.windowTotal == null
      ? `${count} ${pluralNoun(noun, evidence.count)} in ${evidence.window}`
      : `${count} of ${formatCountNumber(evidence.windowTotal)} match in ${evidence.window}`;
    const corpus = evidence.corpusTotal == null
      ? ''
      : `; ${formatCountNumber(evidence.corpusTotal)} in the full corpus`;
    return {
      title,
      summary: `${summary}${corpus}`,
      ariaLabel: `${summary}${corpus}`,
      evidence: evidence.kind,
    };
  }

  const count = formatCountNumber(evidence.count);
  const summary = `${count}+ ${pluralNoun(noun, evidence.count)}`;
  return {
    title: `${count}+`,
    summary,
    ariaLabel: `${summary}; ${countEvidenceScopeText(evidence)}`,
    evidence: evidence.kind,
  };
}
