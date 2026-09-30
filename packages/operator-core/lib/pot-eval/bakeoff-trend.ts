/**
 * bakeoff-trend.ts — the pure trend formatter for the Learning/Benchmark-tab bake-off artifact
 * (plan-implementation-framework-2026-06-15 P-014, activation of P-009).
 *
 * Summarizes a series of framework bake-off results (framework-bake-off.ts BakeoffResult) into
 * compact trend rows the Learning-tab renders over time (sibling of iq-battery / gym). PURE —
 * timestamps are INJECTED (the caller stamps each run), so this is deterministic + unit-testable
 * with no clock. The read-side @papercusp/sync resolver + the nuqs Benchmark-tab component that
 * CONSUME these rows are the owner-gated UI activation (they also need the bake-off delta
 * PERSISTENCE — a stored results source — which is itself owner-budgeted).
 */
import type { BakeoffResult, BakeoffVerdict } from './framework-bake-off';

export interface BakeoffTrendRow {
  flagKey: string;
  verdict: BakeoffVerdict;
  deltaMeanComposite: number;
  deltaGatePassRate: number;
  at: number;
}

export interface BakeoffTrendEntry {
  result: BakeoffResult;
  /** When this bake-off ran (epoch ms) — injected so the formatter stays pure. */
  at: number;
}

/** Flatten bake-off results into trend rows, newest first. Pure. */
export function summarizeBakeoffTrend(entries: readonly BakeoffTrendEntry[]): BakeoffTrendRow[] {
  return entries
    .map(
      (e): BakeoffTrendRow => ({
        flagKey: e.result.flagKey,
        verdict: e.result.delta.verdict,
        deltaMeanComposite: e.result.delta.deltaMeanComposite,
        deltaGatePassRate: e.result.delta.deltaGatePassRate,
        at: e.at,
      }),
    )
    .sort((a, b) => b.at - a.at);
}

/**
 * The LATEST verdict per flag — each bet's current standing (what the tab badges). Expects rows
 * newest-first (summarizeBakeoffTrend's output); the first row seen per flag is its latest.
 */
export function latestVerdictByFlag(rows: readonly BakeoffTrendRow[]): Record<string, BakeoffVerdict> {
  const out: Record<string, BakeoffVerdict> = {};
  for (const r of rows) {
    if (!(r.flagKey in out)) out[r.flagKey] = r.verdict;
  }
  return out;
}
