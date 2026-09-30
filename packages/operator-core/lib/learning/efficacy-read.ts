/**
 * efficacy-read.ts — the four "is the system actually LEARNING" metrics behind the
 * Learning tab's efficacy panel (relight-self-learning-edges-2026-06-14 P-020).
 *
 * The flow strip already shows THROUGHPUT (captured/resolved/recurring/watchdog).
 * This is the complementary EFFICACY view: did the learning actually hold?
 *
 *   1. auto-fix survival rate — of matured fix-survival calibration bets, what
 *      fraction of auto-fixes stayed fixed (calibration_predictions, domain
 *      'fix-survival', organic provenance);
 *   2. champion score-delta vs the gen-0 baseline — the latest scored IQ-battery
 *      generation's mean judge composite minus gen-0 (gen0-93b50cb39, composite
 *      5.950), off the beekeeper apiary trend;
 *   3. recurrence-decay — of fixes that reached a lifecycle verdict, the share
 *      that VERIFIED (stayed fixed) vs RECURRED (engineer_issues idea lifecycle);
 *   4. memory FP@5 — the latest memory-precision-bench false-positive rate
 *      (harness_shared.memory_precision_bench, P-033).
 *
 * Every metric DEGRADES honestly: most of this data is YOUNG (calibration bets
 * mature ~14d out; the gym/iq-battery trend warms as generations land; the
 * lifecycle needs 14d+ quiet) — so each metric carries a `state` of `ok` (has
 * matured data) / `warming` (machinery live, nothing matured yet) / `none` (no
 * machinery/data), and the panel renders the honest state, never a fake number.
 *
 * Pure-ish: the SQL reads take an injected `Sql` (admin pool); the assembly of
 * the apiary + memory-precision metrics is pure (the resolver supplies the
 * already-read snapshots) so they stay unit-testable without a live PG.
 */
import type { Sql } from 'postgres';
import type { ApiaryInstanceSummary } from '../iq-battery/benchmark-read';
import type { MemoryPrecisionSnapshot } from '../memory/bench/precision-read';

/**
 * The gen-0 IQ-battery baseline the champion score-delta anchors to
 * (relight P-020): generation 0 at git sha 93b50cb39 scored composite 5.950 on
 * the frozen battery. The absolute per-generation composite lives in the
 * ephemeral gym execution DB, but the sealed beekeeper trend records each
 * generation's mean composite — so the delta vs this baseline is the durable
 * "is the system getting smarter" number.
 */
export const GEN0_BASELINE = { championId: 'gen0-93b50cb39', composite: 5.95 } as const;

export type EfficacyState = 'ok' | 'warming' | 'none';

/** One efficacy metric: a value, the sample that backs it, and an honest state. */
export interface EfficacyMetric {
  /** Primary value — semantics per metric (rate / delta / ratio). Null = no value yet. */
  value: number | null;
  /** Sample size backing the value (matured bets / scored gens / verdicts / runs). */
  sample: number;
  /** ok = matured data; warming = machinery live, nothing matured; none = no machinery. */
  state: EfficacyState;
  /** Short human detail for the chip tooltip. */
  detail?: string;
}

export interface LearningEfficacy {
  /** Fraction of matured fix-survival bets whose fix survived (0..1). */
  autoFixSurvival: EfficacyMetric;
  /** Latest scored generation's composite minus the gen-0 baseline (signed). */
  championDelta: EfficacyMetric;
  /** Verified / (verified + recurred) — the share of fixes that decayed cleanly (0..1). */
  recurrenceDecay: EfficacyMetric;
  /** Latest memory-precision-bench hard-negative FP@5 (0..1; lower is better). */
  memoryFpAt5: EfficacyMetric;
  /** The documented gen-0 baseline the champion delta anchors to. */
  gen0Baseline: { championId: string; composite: number };
}

const NONE: EfficacyMetric = { value: null, sample: 0, state: 'none' };

/** The all-empty efficacy snapshot — every metric in its `none` state. */
export const EMPTY_EFFICACY: LearningEfficacy = {
  autoFixSurvival: NONE,
  championDelta: NONE,
  recurrenceDecay: NONE,
  memoryFpAt5: NONE,
  gen0Baseline: { ...GEN0_BASELINE },
};

/**
 * Auto-fix survival rate over matured fix-survival bets (organic provenance only,
 * per D-002 @ calibration — drill/replay/shadow bets are not the real outcome).
 * A resolved bet with NULL outcome is VOIDED (undeterminable) and excluded from
 * the rate; only scored (outcome IS NOT NULL) bets count.
 */
export async function readAutoFixSurvival(sql: Sql, workspaceId: string): Promise<EfficacyMetric> {
  const rows = (await sql`
    SELECT
      count(*) FILTER (WHERE outcome IS NOT NULL)::int AS matured,
      count(*) FILTER (WHERE outcome = true)::int      AS survived,
      count(*)::int                                    AS total
      FROM harness_shared.calibration_predictions
     WHERE workspace_id = ${workspaceId}
       AND domain = 'fix-survival'
       AND signal_origin = 'organic'
  `) as Array<{ matured: number; survived: number; total: number }>;
  const r = rows[0] ?? { matured: 0, survived: 0, total: 0 };
  const matured = Number(r.matured);
  const total = Number(r.total);
  if (matured > 0) {
    return {
      value: Number(r.survived) / matured,
      sample: matured,
      state: 'ok',
      detail: `${r.survived}/${matured} matured fix-survival bets held (${total} placed)`,
    };
  }
  return {
    value: null,
    sample: 0,
    state: total > 0 ? 'warming' : 'none',
    detail: total > 0 ? `${total} bets placed, none matured yet (~14d horizon)` : 'no fix-survival bets yet',
  };
}

/**
 * Recurrence-decay: of fixes that reached a lifecycle VERDICT, the share that
 * VERIFIED (stayed fixed) vs RECURRED. Reads the idea-lifecycle state the decay
 * sweep writes onto engineer_issues.payload.ideaLifecycle (self-learning-central
 * P-030/P-031). Higher is better (more fixes decayed away cleanly).
 */
export async function readRecurrenceDecay(sql: Sql, workspaceId: string): Promise<EfficacyMetric> {
  const rows = (await sql`
    SELECT
      count(*) FILTER (WHERE payload->'ideaLifecycle'->>'state' = 'verified')::int AS verified,
      count(*) FILTER (WHERE payload->'ideaLifecycle'->>'state' = 'recurred')::int AS recurred
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${workspaceId}
       AND payload->'ideaLifecycle'->>'state' IN ('verified', 'recurred')
  `) as Array<{ verified: number; recurred: number }>;
  const r = rows[0] ?? { verified: 0, recurred: 0 };
  const verified = Number(r.verified);
  const recurred = Number(r.recurred);
  const judged = verified + recurred;
  if (judged > 0) {
    return {
      value: verified / judged,
      sample: judged,
      state: 'ok',
      detail: `${verified} verified / ${recurred} recurred (of ${judged} that reached a verdict)`,
    };
  }
  return {
    value: null,
    sample: 0,
    state: 'warming',
    detail: 'no fixes have reached a verify/recur verdict yet (~14d quiet window)',
  };
}

/**
 * Champion score-delta vs the gen-0 baseline — PURE over the already-read apiary
 * summaries (newest-first). The most-recent SCORED generation is the current
 * champion; its mean composite minus the gen-0 baseline is the delta. Negative
 * deltas (a regression vs gen-0) are reported honestly, not clamped.
 */
export function championDeltaMetric(
  summaries: readonly ApiaryInstanceSummary[],
  gen0Composite: number,
): EfficacyMetric {
  const scored = summaries.filter((s) => s.meanComposite != null);
  if (scored.length === 0) {
    return {
      value: null,
      sample: 0,
      state: summaries.length > 0 ? 'warming' : 'none',
      detail:
        summaries.length > 0
          ? `${summaries.length} generation(s) run, none judged yet`
          : 'no benchmark generations yet (the IQ-battery is owner-budget-gated)',
    };
  }
  const champion = scored[0];
  const composite = champion.meanComposite as number;
  return {
    value: composite - gen0Composite,
    sample: scored.length,
    state: 'ok',
    detail: `gen ${champion.codeSha.slice(0, 8)} composite ${composite.toFixed(2)} vs gen-0 ${gen0Composite.toFixed(2)}`,
  };
}

/**
 * Memory FP@5 — PURE over the already-read memory-precision snapshot (P-033).
 * The latest bench's hard-negative false-positive rate; lower is better. The
 * delta vs the previous run gives the trend direction.
 */
export function memoryFpAt5Metric(snapshot: MemoryPrecisionSnapshot): EfficacyMetric {
  const latest = snapshot.latest;
  if (latest && latest.fpAt5 != null) {
    const delta = snapshot.fpAt5Delta;
    const trendNote = delta == null ? '' : delta <= 0 ? ` (↓${Math.abs(delta).toFixed(2)})` : ` (↑${delta.toFixed(2)})`;
    return {
      value: latest.fpAt5,
      sample: snapshot.runCount,
      state: 'ok',
      detail: `FP@5 ${latest.fpAt5.toFixed(2)}${trendNote} over ${snapshot.runCount} bench run(s) @ floor ${latest.floorCosine}/${latest.floorLex}`,
    };
  }
  return {
    value: null,
    sample: snapshot.runCount,
    state: snapshot.runCount > 0 ? 'warming' : 'none',
    detail: snapshot.runCount > 0 ? 'bench ran but no hard-negative score yet' : 'memory not benchmarked yet (weekly cadence)',
  };
}
