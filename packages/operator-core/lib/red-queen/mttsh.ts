/**
 * mttsh.ts — pure MTTSH (mean-time-to-self-heal) aggregation
 * (self-learning-frontier-2026-06-12 P-031 / FB-20).
 *
 * Turns drill outcome rows into the Learning tab's vital sign: per-class and
 * overall medians for each segment (detect → triage → fix), resolve rate,
 * triage accuracy vs the planted known answers, and the zero-leak record.
 * Pure + deterministic — the store feeds it rows; the resolver feeds the panel.
 */

import type { DrillOutcome } from './types';

export interface MttshClassVital {
  drillClass: string;
  collectorFamily: string;
  runs: number;
  resolved: number;
  /** Median per segment over RESOLVED runs (ms); null until one resolves. */
  detectMs: number | null;
  triageMs: number | null;
  fixMs: number | null;
  totalMs: number | null;
  /** Triage decisions matching the planted expectation, over runs that were triaged AND pin one. */
  triageMatches: number;
  triageJudged: number;
  /** Any run with a failed leak check is a standing alarm. */
  leakFailures: number;
  lastRunAt: string | null;
  lastStatus: string | null;
}

export interface MttshVitals {
  classes: MttshClassVital[];
  totalRuns: number;
  totalResolved: number;
  /** Overall median total MTTSH (ms) across resolved runs. */
  medianTotalMs: number | null;
  leakFailures: number;
  lastRunAt: string | null;
}

export const EMPTY_MTTSH_VITALS: MttshVitals = {
  classes: [],
  totalRuns: 0,
  totalResolved: 0,
  medianTotalMs: null,
  leakFailures: 0,
  lastRunAt: null,
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const later = (a: string | null, b: string | null): string | null =>
  a == null ? b : b == null ? a : a > b ? a : b;

/** Pure: outcome rows (any order) → the vitals snapshot. */
export function computeMttshVitals(outcomes: DrillOutcome[]): MttshVitals {
  const byClass = new Map<string, DrillOutcome[]>();
  for (const o of outcomes) {
    const list = byClass.get(o.drillClass) ?? [];
    list.push(o);
    byClass.set(o.drillClass, list);
  }

  const classes: MttshClassVital[] = [];
  const allTotals: number[] = [];
  let totalResolved = 0;
  let leakFailures = 0;
  let lastRunAt: string | null = null;

  for (const [drillClass, runs] of byClass) {
    const resolved = runs.filter((r) => r.status === 'resolved');
    const seg = (pick: (m: NonNullable<DrillOutcome['mttsh']>) => number | undefined): number[] =>
      resolved
        .map((r) => (r.mttsh ? pick(r.mttsh) : undefined))
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
    const totals = seg((m) => m.totalMs);
    allTotals.push(...totals);
    totalResolved += resolved.length;

    const judged = runs.filter((r) => r.expectedDecision && r.triagedDecision);
    const matches = judged.filter((r) => r.triagedDecision === r.expectedDecision);
    const classLeaks = runs.filter((r) => r.leakCheckPassed === false).length;
    leakFailures += classLeaks;

    const newest = runs.reduce<DrillOutcome | null>(
      (best, r) => (best == null || r.plantedAt > best.plantedAt ? r : best),
      null,
    );
    lastRunAt = later(lastRunAt, newest?.plantedAt ?? null);

    classes.push({
      drillClass,
      collectorFamily: runs[0]?.collectorFamily ?? '',
      runs: runs.length,
      resolved: resolved.length,
      detectMs: median(seg((m) => m.detectMs)),
      triageMs: median(seg((m) => m.triageMs)),
      fixMs: median(seg((m) => m.fixMs)),
      totalMs: median(totals),
      triageMatches: matches.length,
      triageJudged: judged.length,
      leakFailures: classLeaks,
      lastRunAt: newest?.plantedAt ?? null,
      lastStatus: newest?.status ?? null,
    });
  }

  classes.sort((a, b) => a.drillClass.localeCompare(b.drillClass));
  return {
    classes,
    totalRuns: outcomes.length,
    totalResolved,
    medianTotalMs: median(allTotals),
    leakFailures,
    lastRunAt,
  };
}
