/**
 * ab-verdict.ts — the gym's arm-level compare/select verdict
 * (test-gym-apiary-framework-2026-06-09 P-005).
 *
 * The gym already RUNS on the shared substrate (its loop is eval-battery's
 * `runBattery`, its judge the shared BatteryJudge, its tests on the tab via the
 * gym testing domain). What it lacked was the substrate's VERDICT: `AbResult`
 * carries per-task deltas (`comparison`, store-level P-013) and variance, but
 * no ranked arm-level select. This adapter maps a finished A/B battery onto the
 * shared compare/select core (`compareArms`) — baseline vs candidate variants,
 * judge-composite + cost metrics, strict-improvement selection — so a gym run
 * concludes with the SAME verdict shape a tab scenario eval produces.
 *
 * That shape is `EvalVerdictLike`-compatible, so a gym verdict feeds the Scout
 * meta-learning wire (eval-verdict-wire P-004) unchanged: gym eval → verdict →
 * accepted/rejected change-feed entries → lens weights. No parallel ranking
 * machinery (D-001), the blueprint stays the gym's own.
 *
 * Scored-only discipline matches the variance sampler (RB-006): rate-limited /
 * errored cells carry no real composite and are EXCLUDED from the judge metric;
 * a variant with NO scored cells at all becomes an errored arm (recorded, never
 * ranked) rather than a fake zero.
 */

import {
  BASELINE_ID,
  compareArms,
  type CompareArm,
  type CompareSelectResult,
} from '@papercusp/eval-battery';
import type { AbResult, AbRunOutcome } from './ab-runner';

/** The gym verdict's metric vocabulary (Scorer-id style, directions included). */
export const GYM_VERDICT_METRICS = [
  { id: 'judge:composite', direction: 'higher-better' } as const,
  { id: 'mean-cost-usd', direction: 'lower-better' } as const,
];

function isScored(o: AbRunOutcome): boolean {
  return (o.status ?? 'scored') === 'scored';
}

function armOf(variantId: string, armId: string, outcomes: AbRunOutcome[]): CompareArm {
  const mine = outcomes.filter((o) => o.variantId === variantId);
  const scored = mine.filter(isScored);
  if (scored.length === 0) {
    return {
      variantId: armId,
      metrics: {},
      error: `variant '${variantId}' has no scored runs (${mine.length} cells, all rate-limited/errored)`,
    };
  }
  const meanComposite = scored.reduce((s, o) => s + o.composite, 0) / scored.length;
  const meanCost = mine.reduce((s, o) => s + o.pipelineUsd + o.judgeUsd, 0) / mine.length;
  return {
    variantId: armId,
    metrics: { 'judge:composite': meanComposite, 'mean-cost-usd': meanCost },
  };
}

export interface AbVerdictOpts {
  /** Verdict scenario id (default `gym-ab:<rubricHash>`). */
  scenarioId?: string;
  /** Required judge-composite improvement to select a candidate (default 0). */
  minDelta?: number;
}

/**
 * Rank + select over a finished gym A/B battery. `baselineVariantId` names the
 * incumbent (the gym's variant[0] = A convention — explicit here so a caller
 * can never mislabel the baseline); every other variant present in the
 * outcomes becomes a candidate arm, in first-appearance (variant-major) order.
 */
export function abVerdict(result: AbResult, baselineVariantId: string, opts: AbVerdictOpts = {}): CompareSelectResult {
  const variantIds: string[] = [];
  for (const o of result.outcomes) {
    if (!variantIds.includes(o.variantId)) variantIds.push(o.variantId);
  }
  if (!variantIds.includes(baselineVariantId)) {
    throw new Error(`abVerdict: baseline variant '${baselineVariantId}' has no outcomes in this AbResult`);
  }

  const baseline = armOf(baselineVariantId, BASELINE_ID, result.outcomes);
  const candidates = variantIds
    .filter((v) => v !== baselineVariantId)
    .map((v) => armOf(v, v, result.outcomes));

  const compared = compareArms({
    baseline,
    candidates,
    scorers: GYM_VERDICT_METRICS,
    primary: 'judge:composite',
    ...(opts.minDelta !== undefined && { minDelta: opts.minDelta }),
  });
  return { scenarioId: opts.scenarioId ?? `gym-ab:${result.rubricHash}`, ...compared };
}
