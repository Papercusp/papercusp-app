/**
 * Pilot metrics — the per-arm summary for the 3-arm directed-pair pilot
 * (plan `directed-pair-work-items-2026-08-25`, P-006).
 *
 * ## The rule this module exists to enforce mechanically
 *
 * D-022 measured this harness's own ledger and found D-007's metric list power-inverted:
 * the metrics named first are the ones that cannot fire at the pilot's size. Reopens run at
 * 0.74%, so a 21-item pilot has an 85.6% chance of observing ZERO across all three arms; the
 * highest-variance binary available (filesChanged, 44.5%) reaches only 7.9% Fisher power for
 * a 30-point difference at n=7/arm, needing n≈50/arm for 80%.
 *
 * A prose ruling saying "don't report those as rates" survives exactly as long as the next
 * agent's attention. So {@link summariseArm} REFUSES to emit a rate for a metric whose event
 * count is below {@link MIN_EVENTS_FOR_RATE}, and hands back a raw count plus the reason
 * instead. The finding is encoded, not remembered.
 *
 * ## Cost attribution — the trap that would make the pair look free
 *
 * Token cost is recorded per AGENT SESSION (`agent_usage_samples`, `agent_loop_sessions`),
 * never per work item. Attribution is therefore by (agent, claim window) — and for arm C
 * that window covers TWO agents, director and implementer. A collector that sums one agent
 * per item reports the pair at roughly half its true cost, which inverts the entire
 * cost-benefit question the pilot exists to answer. {@link ArmObservation.agentCostsUsd} is
 * an ARRAY for this reason: there is no single-agent shape to fall into by accident.
 *
 * @see D-007  the 3-arm pilot and its metric list
 * @see D-022  the measured base rates, the power computation, and the screening-study ruling
 */

import { type PilotArm } from './pilot-arm-assignment.js';

/**
 * Below this many observed events, a proportion is not an estimate.
 *
 * Five is not a magic number — it is the conventional floor below which a normal
 * approximation to a binomial is meaningless, and at the pilot's expected event counts
 * (0.05 reopens per arm) it is never reached, which is exactly the point D-022 makes.
 */
export const MIN_EVENTS_FOR_RATE = 5;

/** D-033: the achieved sample floor and preregistered substantive-tier verdict thresholds. */
export const PILOT_MIN_ARM_N = 7;
export const PILOT_LARGE_EFFECT_D = 1.6;
export const PILOT_MIN_SCORE_DELTA = 1;
export const PILOT_MAX_INCREMENTAL_COST_PER_POINT_REFERENCE_UNITS = 1;

export interface ArmObservation {
  readonly itemId: string;
  readonly arm: PilotArm;
  /**
   * The PRIMARY metric: a continuous per-item score from the graded acceptance rubric.
   * Continuous because it is the only metric family that can carry a decision at n≈7/arm
   * (D-022): every item yields one, so 21 items give 21 observations rather than 21 coin
   * flips at p=0.007.
   */
  readonly score: number;
  /** Wall-clock from claim to terminal close. */
  readonly wallClockMs?: number;
  /**
   * Cost per PARTICIPATING AGENT. Arm C carries two entries (director + implementer);
   * arms A and B carry one. See the module note — a scalar here would silently halve the
   * pair's measured cost.
   */
  readonly agentCostsUsd?: readonly number[];
  /** Rare-event tripwires. Reported as counts, never as rates (D-022). */
  readonly reopened?: boolean;
  readonly authorityProposed?: boolean;
}

export interface RareEventCount {
  readonly events: number;
  readonly n: number;
  /**
   * The observed proportion, or `null` when too few events were seen for it to mean
   * anything. `null` is the honest reading — never coerce it to 0.
   */
  readonly rate: number | null;
  /** Why `rate` is null, so a reader is never left guessing. */
  readonly rateWithheldReason?: string;
}

export interface ArmSummary {
  readonly arm: PilotArm;
  readonly n: number;
  /** Coverage counters make a partially scored/priced arm mechanically visible. */
  readonly scoredN: number;
  readonly costedN: number;
  /** Primary metric. */
  readonly meanScore: number | null;
  readonly sdScore: number | null;
  /** 95% CI on the mean. `null` when n < 2 — a single observation has no interval. */
  readonly scoreCi95: readonly [number, number] | null;
  readonly meanWallClockMs: number | null;
  /** Total cost across every participating agent — the pair's real price. */
  readonly totalCostUsd: number | null;
  readonly meanCostPerItemUsd: number | null;
  readonly reopened: RareEventCount;
  readonly authorityProposed: RareEventCount;
}

/* ------------------------------------------------------------------ *
 * Statistics
 * ------------------------------------------------------------------ */

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Sample standard deviation (n-1). `null` below two observations. */
export function sampleSd(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const ss = xs.reduce((acc, x) => acc + (x - m) ** 2, 0);
  return Math.sqrt(ss / (xs.length - 1));
}

/**
 * Two-sided t critical values at alpha=.05, indexed by degrees of freedom.
 *
 * A table rather than an approximation because the pilot lives at df 5–20, exactly where
 * the normal approximation (1.96) is worst — at df=6 the true value is 2.447, so using 1.96
 * would report intervals ~25% too narrow and make a null look like a finding.
 */
const T_CRIT_95: Readonly<Record<number, number>> = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  11: 2.201,
  12: 2.179,
  13: 2.16,
  14: 2.145,
  15: 2.131,
  16: 2.12,
  17: 2.11,
  18: 2.101,
  19: 2.093,
  20: 2.086,
};

export function tCritical95(df: number): number {
  if (df < 1) return Number.NaN;
  if (df <= 20) return T_CRIT_95[df]!;
  if (df <= 30) return 2.042;
  if (df <= 60) return 2.0;
  return 1.96;
}

/** 95% confidence interval on the mean. `null` below two observations. */
export function meanCi95(xs: readonly number[]): readonly [number, number] | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const sd = sampleSd(xs)!;
  const half = tCritical95(xs.length - 1) * (sd / Math.sqrt(xs.length));
  return [m - half, m + half];
}

/**
 * Cohen's d with a pooled standard deviation.
 *
 * Reported INSTEAD of a p-value, deliberately. At n=7/arm a significance test answers a
 * question the pilot cannot afford to ask (D-022); an effect size with an interval answers
 * the question the pilot actually has, which is "how big, and how sure are we".
 */
export function cohensD(a: readonly number[], b: readonly number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const sdA = sampleSd(a)!;
  const sdB = sampleSd(b)!;
  const pooled = Math.sqrt(((a.length - 1) * sdA ** 2 + (b.length - 1) * sdB ** 2) / (a.length + b.length - 2));
  if (pooled === 0) return null;
  return (mean(b)! - mean(a)!) / pooled;
}

/* ------------------------------------------------------------------ *
 * Rare-event handling — D-022's ruling, mechanically enforced
 * ------------------------------------------------------------------ */

/**
 * Count a rare binary, withholding the rate when too few events were observed to support
 * one. This is where D-022 stops being prose: a caller cannot obtain a 0/7 "0% reopen rate"
 * from this function, because that number would read as a finding and is not one.
 */
export function countRareEvent(flags: readonly boolean[]): RareEventCount {
  const n = flags.length;
  const events = flags.filter(Boolean).length;
  if (events < MIN_EVENTS_FOR_RATE) {
    return {
      events,
      n,
      rate: null,
      rateWithheldReason:
        `only ${events} event(s) observed in ${n} item(s); below ${MIN_EVENTS_FOR_RATE} a ` +
        `proportion is not an estimate (D-022) — report the raw count and read any event ` +
        `individually`,
    };
  }
  return { events, n, rate: n === 0 ? null : events / n };
}

/* ------------------------------------------------------------------ *
 * Summaries
 * ------------------------------------------------------------------ */

export function summariseArm(arm: PilotArm, observations: readonly ArmObservation[]): ArmSummary {
  const mine = observations.filter((o) => o.arm === arm);
  const scores = mine.map((o) => o.score).filter((s) => Number.isFinite(s));
  const wall = mine.map((o) => o.wallClockMs).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  // Sum across every participating agent — the arm-C correction (see module note).
  const perItemCost = mine
    .map((o) => o.agentCostsUsd)
    .filter((v): v is readonly number[] => Array.isArray(v))
    .map((costs) => costs.reduce((a, b) => a + b, 0));

  const totalCostUsd = perItemCost.length ? perItemCost.reduce((a, b) => a + b, 0) : null;

  return {
    arm,
    n: mine.length,
    scoredN: scores.length,
    costedN: perItemCost.length,
    meanScore: mean(scores),
    sdScore: sampleSd(scores),
    scoreCi95: meanCi95(scores),
    meanWallClockMs: mean(wall),
    totalCostUsd,
    meanCostPerItemUsd: mean(perItemCost),
    reopened: countRareEvent(mine.map((o) => o.reopened === true)),
    authorityProposed: countRareEvent(mine.map((o) => o.authorityProposed === true)),
  };
}

export interface PilotReport {
  readonly arms: Readonly<Record<PilotArm, ArmSummary>>;
  /** Effect size of each arm against arm A, the solo baseline. */
  readonly effectVsBaseline: Readonly<Record<'B' | 'C', number | null>>;
  /** P-008's substantive-tier comparison: directed pair against solo + review. */
  readonly effectVsReviewGate: Readonly<Record<'C', number | null>>;
  /**
   * The honest reading of what this pilot can and cannot conclude, derived from the
   * ACHIEVED n rather than the planned one — an early-stopped pilot must not inherit the
   * plan's power claim.
   */
  readonly interpretation: string;
}

export function buildPilotReport(observations: readonly ArmObservation[]): PilotReport {
  const arms = {
    A: summariseArm('A', observations),
    B: summariseArm('B', observations),
    C: summariseArm('C', observations),
  } as const;

  const scoresFor = (arm: PilotArm) => observations.filter((o) => o.arm === arm).map((o) => o.score);

  const smallestArm = Math.min(arms.A.n, arms.B.n, arms.C.n);

  return {
    arms,
    effectVsBaseline: {
      B: cohensD(scoresFor('A'), scoresFor('B')),
      C: cohensD(scoresFor('A'), scoresFor('C')),
    },
    effectVsReviewGate: {
      C: cohensD(scoresFor('B'), scoresFor('C')),
    },
    interpretation: interpretationFor(smallestArm),
  };
}

/* ------------------------------------------------------------------ *
 * Adaptive tier verdict — D-033 preregistered before any pilot outcome
 * ------------------------------------------------------------------ */

export type AdaptiveTierGateStatus = 'ready' | 'insufficient-evidence' | 'tripwire-review';

export interface AdaptiveTierPolicy {
  readonly trivial: 'A';
  readonly substantive: PilotArm;
  readonly highRisk: 'C';
}

export const DEFAULT_ADAPTIVE_TIER_POLICY: AdaptiveTierPolicy = {
  trivial: 'A',
  substantive: 'B',
  highRisk: 'C',
};

export interface PilotArmComparison {
  readonly reference: 'A' | 'B';
  readonly candidate: 'B' | 'C';
  readonly scoreDelta: number | null;
  readonly effectSize: number | null;
  readonly meanCostDeltaUsd: number | null;
  readonly incrementalCostPerScorePointUsd: number | null;
  readonly maxIncrementalCostPerScorePointUsd: number | null;
  readonly largePositiveEffect: boolean;
  readonly largeNegativeEffect: boolean;
  readonly costJustified: boolean | null;
}

export interface AdaptiveTierGateInput {
  /** The collector's assignment/scorecard/usage evidence has no typed gaps. */
  readonly collectionComplete: boolean;
  /** Every observed rare-event tripwire was individually read and dispositioned. */
  readonly tripwiresAdjudicated?: boolean;
}

export interface AdaptiveTierGateDecision {
  readonly status: AdaptiveTierGateStatus;
  readonly policy: AdaptiveTierPolicy;
  readonly defaultPreserved: boolean;
  readonly comparisons: {
    readonly bVsA: PilotArmComparison;
    readonly cVsB: PilotArmComparison;
  };
  readonly tripwires: {
    readonly reopened: number;
    readonly authorityProposed: number;
    readonly total: number;
    readonly adjudicated: boolean;
  };
  readonly readinessIssues: readonly string[];
  readonly reason: string;
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function comparePilotArms(
  report: PilotReport,
  reference: 'A' | 'B',
  candidate: 'B' | 'C',
  effectSizeInput: number | null,
): PilotArmComparison {
  const referenceScore = finiteOrNull(report.arms[reference].meanScore);
  const candidateScore = finiteOrNull(report.arms[candidate].meanScore);
  const referenceCost = finiteOrNull(report.arms[reference].meanCostPerItemUsd);
  const candidateCost = finiteOrNull(report.arms[candidate].meanCostPerItemUsd);
  const effectSize = finiteOrNull(effectSizeInput);
  const scoreDelta = referenceScore === null || candidateScore === null ? null : candidateScore - referenceScore;
  const meanCostDeltaUsd = referenceCost === null || candidateCost === null ? null : candidateCost - referenceCost;
  const incrementalCostPerScorePointUsd =
    scoreDelta === null || scoreDelta <= 0 || meanCostDeltaUsd === null
      ? null
      : Math.max(0, meanCostDeltaUsd) / scoreDelta;
  const maxIncrementalCostPerScorePointUsd =
    referenceCost === null ? null : referenceCost * PILOT_MAX_INCREMENTAL_COST_PER_POINT_REFERENCE_UNITS;
  const costJustified =
    incrementalCostPerScorePointUsd === null || maxIncrementalCostPerScorePointUsd === null
      ? null
      : incrementalCostPerScorePointUsd <= maxIncrementalCostPerScorePointUsd;

  return {
    reference,
    candidate,
    scoreDelta,
    effectSize,
    meanCostDeltaUsd,
    incrementalCostPerScorePointUsd,
    maxIncrementalCostPerScorePointUsd,
    largePositiveEffect:
      scoreDelta !== null &&
      effectSize !== null &&
      scoreDelta >= PILOT_MIN_SCORE_DELTA &&
      effectSize >= PILOT_LARGE_EFFECT_D,
    largeNegativeEffect:
      scoreDelta !== null &&
      effectSize !== null &&
      scoreDelta <= -PILOT_MIN_SCORE_DELTA &&
      effectSize <= -PILOT_LARGE_EFFECT_D,
    costJustified,
  };
}

/**
 * Turn a complete P-007 report into P-008's tier policy without outcome-time judgement.
 *
 * The default is deliberately sticky: at n=7/arm an inconclusive result cannot rule out a
 * moderate benefit, so it preserves D-007's arm B rather than silently reading null as parity.
 */
export function deriveAdaptiveTierGate(report: PilotReport, input: AdaptiveTierGateInput): AdaptiveTierGateDecision {
  const bVsA = comparePilotArms(report, 'A', 'B', report.effectVsBaseline.B);
  const cVsB = comparePilotArms(report, 'B', 'C', report.effectVsReviewGate.C);
  const readinessIssues: string[] = [];

  if (!input.collectionComplete) readinessIssues.push('collector reported typed evidence gaps');
  for (const arm of ['A', 'B', 'C'] as const) {
    const summary = report.arms[arm];
    if (summary.n < PILOT_MIN_ARM_N) {
      readinessIssues.push(`arm ${arm} achieved n=${summary.n}; need >=${PILOT_MIN_ARM_N}`);
    }
    if (summary.scoredN !== summary.n) {
      readinessIssues.push(`arm ${arm} has scores for ${summary.scoredN}/${summary.n} item(s)`);
    }
    if (summary.costedN !== summary.n) {
      readinessIssues.push(`arm ${arm} has costs for ${summary.costedN}/${summary.n} item(s)`);
    }
  }
  if (bVsA.effectSize === null) readinessIssues.push('B-vs-A effect size is unavailable');
  if (cVsB.effectSize === null) readinessIssues.push('C-vs-B effect size is unavailable');

  const reopened = (['A', 'B', 'C'] as const).reduce((sum, arm) => sum + report.arms[arm].reopened.events, 0);
  const authorityProposed = (['A', 'B', 'C'] as const).reduce(
    (sum, arm) => sum + report.arms[arm].authorityProposed.events,
    0,
  );
  const tripwires = {
    reopened,
    authorityProposed,
    total: reopened + authorityProposed,
    adjudicated: input.tripwiresAdjudicated === true,
  } as const;
  const defaultPolicy = { ...DEFAULT_ADAPTIVE_TIER_POLICY };
  const base = { comparisons: { bVsA, cVsB }, tripwires, readinessIssues } as const;

  if (readinessIssues.length) {
    return {
      ...base,
      status: 'insufficient-evidence',
      policy: defaultPolicy,
      defaultPreserved: true,
      reason: `D-007 policy preserved: ${readinessIssues.join('; ')}.`,
    };
  }
  if (tripwires.total > 0 && !tripwires.adjudicated) {
    return {
      ...base,
      status: 'tripwire-review',
      policy: defaultPolicy,
      defaultPreserved: true,
      reason:
        `D-007 policy preserved pending individual review of ${tripwires.reopened} reopen ` +
        `and ${tripwires.authorityProposed} proposed-authority event(s).`,
    };
  }

  // Large detected harm takes precedence over upgrading a policy whose reference arm failed.
  if (bVsA.largeNegativeEffect) {
    return {
      ...base,
      status: 'ready',
      policy: { ...defaultPolicy, substantive: 'A' },
      defaultPreserved: false,
      reason: 'Substantive tier demoted to A: B showed preregistered large harm versus A.',
    };
  }
  if (cVsB.largePositiveEffect && cVsB.costJustified === true) {
    return {
      ...base,
      status: 'ready',
      policy: { ...defaultPolicy, substantive: 'C' },
      defaultPreserved: false,
      reason: 'Substantive tier promoted to C: C showed a large, cost-justified effect versus B.',
    };
  }
  return {
    ...base,
    status: 'ready',
    policy: defaultPolicy,
    defaultPreserved: true,
    reason:
      'Substantive tier remains B: no preregistered large, cost-justified C-over-B effect or ' +
      'large B harm was detected; an inconclusive screening result is not parity.',
  };
}

/**
 * The sentence that keeps a null from being misread.
 *
 * At the pilot's size a null result means "no large effect detected", never "no effect
 * exists" — D-022 calls this the specific misreading the numbers make near-certain if left
 * unstated. Generated from the achieved n so it cannot drift from the data it describes.
 */
export function interpretationFor(smallestArmN: number): string {
  if (smallestArmN === 0) return 'No observations — nothing can be concluded.';
  const detectable = smallestArmN >= 26 ? 0.8 : smallestArmN >= 12 ? 1.2 : smallestArmN >= 7 ? 1.6 : 2.0;
  return (
    `SCREENING study (smallest arm n=${smallestArmN}). At this size the comparison can ` +
    `detect roughly Cohen d>=${detectable.toFixed(1)} at 80% power on the continuous score. ` +
    `A null result means NO LARGE EFFECT WAS DETECTED — it is not evidence that the arms ` +
    `perform equally (D-022). Rare-event counts (reopens, proposed-authority closes) are ` +
    `tripwires to read individually, not rates to compare.`
  );
}
