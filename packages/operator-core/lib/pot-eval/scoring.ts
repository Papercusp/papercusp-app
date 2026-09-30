/**
 * Hive-evaluation COMPOSITE SCORE + the un-gameable GATE (HE-06, P-040/P-041) — the layer that
 * turns the three metric bundles (outcome · efficiency · speed) into ONE scored verdict per run.
 *
 * Two un-gameable moves, both deterministic, both computed — never the Hive's own report:
 *
 *  1. **The OUTCOME GATE (D-002).** Efficiency + speed credit is ZERO unless the run did a GOOD
 *     job: passed the objective acceptance bar AND caught the planted bug AND fabricated nothing
 *     ({@link OutcomeMetrics.outcomeGatePassed}). So you cannot win by shipping fast garbage, by
 *     not coordinating (collisions tank outcome), or by spawning useless bees — quality gates;
 *     efficiency/speed only optimize WITHIN the gate.
 *
 *  2. **The DETERMINISTIC FLOOR (P-041).** Above the gate, a set of un-gameable signals
 *     (`regressionsFromTests`, `plantedBugCaught`, the new `fabricationDetected`, and the COMPUTED
 *     critical-path ratio — never self-reported) impose a CEILING on the composite that an
 *     LLM judge cannot soften. The efficiency/speed sub-scores are themselves computed from
 *     MEASURED metrics, so the judge's composite is recorded as advisory-only ({@link HiveScore.judgeComposite})
 *     and CANNOT raise the score. The floor is the part of the score the optimizer can't talk its
 *     way past.
 *
 * D-003 is honored in the efficiency sub-scores: every "win" is discounted by its paired failure
 * — low-communication credit is multiplied by a collision-rate credit factor, high-parallelism
 * credit by a useless-bee-rate factor — so "efficient" can only mean efficient-AND-effective,
 * never cheap-looking. The pairings come straight off {@link EfficiencyMetrics.pairings}.
 *
 * Pure + deterministic (no IO, no LLM). The rubric (weights + thresholds) is frozen per run and
 * {@link hiveScoreRubricHash} keys it — any change that would change a score changes the hash, so
 * cached scores under an old rubric are never silently mixed with a new one (the beekeeper
 * rubric-hash store pattern; the score store keys on `(run_id, rubric_hash)`).
 */
import { createHash } from 'node:crypto';
import type { OutcomeMetrics } from './outcome-metrics';
import type { EfficiencyMetrics } from './efficiency-metrics';
import type { SpeedMetrics } from './speed-metrics';
import type { HiveEvalScoreRow } from './store';

// ───────────────────────────── the rubric ─────────────────────────────

/** Relative weights of the two scored axes (outcome is the GATE, not a weighted axis). */
export interface AxisWeights {
  efficiency: number;
  speed: number;
}

/** Relative weights of the efficiency sub-metrics. The two `queen*` weights apply only when the run
 *  carried Queen-wake samples (B-06); a run without them is scored on the first four alone. */
export interface EfficiencyWeights {
  parallelism: number;
  communication: number;
  rework: number;
  cost: number;
  /** Queen frozen-prefix cache-hit ratio (Win-1). Lower weight — a narrower, prompt-assembly signal. */
  queenCache: number;
  /** Queen turns-per-wake (Win-2 round-trips). Lower weight — a narrower, prompt-assembly signal. */
  queenRoundTrip: number;
  /** Bee warm-inject carry share (P-015 — lower=fresher). Scored only when the run warm-injected bees.
   *  Lower weight — a narrow, per-bee context-hygiene signal (the bee analog of the two queen wins). */
  beeCarry: number;
}

/** Relative weights of the speed sub-metrics (criticalPath is primary). */
export interface SpeedWeights {
  criticalPath: number;
  firstPlacement: number;
  stuck: number;
}

/**
 * The thresholds that normalize raw metrics into 0–10 sub-scores. A "ceiling" is the value at
 * which a lower-is-better metric scores 0 (and 0 scores 10); a pairing ceiling is the
 * failure-rate at which a paired win earns zero credit (D-003).
 */
export interface HiveScoreThresholds {
  /** Coord-messages-per-completed-item considered maximally wasteful → comms sub-score 0. */
  communicationOverheadCeiling: number;
  /** Collision-rate at which low-communication earns zero credit (D-003 pairing). */
  collisionRateCeiling: number;
  /** Useless-bee-rate at which high-parallelism earns zero credit (D-003 pairing). */
  uselessBeeRateCeiling: number;
  /** Rework-per-item considered maximally bad → rework sub-score 0. */
  reworkRateCeiling: number;
  /** USD-per-completed-item considered maximally expensive → cost sub-score 0. */
  costPerItemUsdCeiling: number;
  /** Queen turns-per-wake at which the round-trip sub-score is 0 (0 turns ⇒ 10). The precomputed
   *  brief (B-03) should keep the Queen's turns/wake well under this; a wake that re-fetches the
   *  whole survey family by hand burns many round-trips. */
  queenTurnsPerWakeCeiling: number;
  /** Bee warm-inject carry-share at which the carry sub-score is 0 (carry share 0 ⇒ 10). 1.0 is the
   *  physical max (the whole bee prompt is resumed-transcript carry — the long-lived-bee anti-pattern
   *  D-011 measured at ~0.97). A fresh-context bee carries ~0 ⇒ ~10; the before/after fork win is the
   *  jump from a near-0 sub-score to a high one. */
  beeCarryShareCeiling: number;
  /** Critical-path ratio at which the speed sub-score is 0 (1.0 ⇒ 10; the D-004 discriminator). */
  criticalPathRatioCeiling: number;
  /** Time-to-first-placement (ms) considered maximally slow-to-start → 0. */
  timeToFirstPlacementMsCeiling: number;
  /** Max stuck-while-ready (ms) considered maximally bad → 0. */
  maxStuckMsCeiling: number;
  /**
   * The DETERMINISTIC-FLOOR ceiling (P-041): when a pre-existing green test regressed, the whole
   * composite is capped here regardless of how fast/parallel the run looked — a regression is an
   * un-gameable signal the judge cannot soften.
   */
  regressionCompositeCeiling: number;
}

/** The frozen scoring parameters; {@link hiveScoreRubricHash} is its cache key. */
export interface HiveScoreRubric {
  /** Bump to deliberately invalidate the cache / start a new comparison basis. */
  version: string;
  axisWeights: AxisWeights;
  efficiencyWeights: EfficiencyWeights;
  speedWeights: SpeedWeights;
  thresholds: HiveScoreThresholds;
}

/**
 * The default rubric. Thresholds are deliberate, documented starting points (not tuned against a
 * live corpus yet — the cadence trend HE-07 builds is what tunes them). Correctness-primary:
 * outcome is the GATE, then efficiency and speed weigh equally above it.
 */
export const DEFAULT_HIVE_SCORE_RUBRIC_V1: Readonly<HiveScoreRubric> = Object.freeze({
  // v2 (2026-06-14): B-06 added the two queen per-wake efficiency sub-metrics (queenCache,
  // queenRoundTrip). v3 (2026-06-15): P-015 added the bee warm-inject carry sub-metric (beeCarry) —
  // the bee analog of the queen wins. The constant name is kept (its many importers) — the version
  // string is the human-legible cache-basis key; the rubric hash changes regardless, so old scores
  // never mix.
  version: 'hive-score-v3',
  axisWeights: { efficiency: 1, speed: 1 },
  efficiencyWeights: { parallelism: 1, communication: 1, rework: 1, cost: 1, queenCache: 0.5, queenRoundTrip: 0.5, beeCarry: 0.5 },
  speedWeights: { criticalPath: 3, firstPlacement: 1, stuck: 1 },
  thresholds: {
    communicationOverheadCeiling: 12, // ≥12 coord msgs per completed item ⇒ no comms credit
    collisionRateCeiling: 0.5, // ≥0.5 collisions/item ⇒ low-comms earns no credit
    uselessBeeRateCeiling: 0.5, // ≥half the bees did no work ⇒ parallelism earns no credit
    reworkRateCeiling: 2, // ≥2 rework events/item ⇒ no rework credit
    costPerItemUsdCeiling: 5, // ≥$5/item ⇒ no cost credit
    queenTurnsPerWakeCeiling: 12, // ≥12 turns/wake ⇒ no round-trip credit (survey re-fetched by hand)
    beeCarryShareCeiling: 1, // carry = 100% of bee prompt ⇒ no carry credit (the long-bee anti-pattern)
    criticalPathRatioCeiling: 3, // ≥3× the ideal makespan ⇒ no speed credit (badly serialized)
    timeToFirstPlacementMsCeiling: 120_000, // ≥2 min to first placement ⇒ no start-latency credit
    maxStuckMsCeiling: 300_000, // ≥5 min stuck-while-ready ⇒ no stuck credit
    regressionCompositeCeiling: 3, // a regression caps the whole composite at 3/10
  },
});

// ───────────────────────────── the score shape ─────────────────────────────

/** One sub-metric's contribution to an axis: its raw value, its 0–10 score, and a human note. */
export interface ScoreComponent {
  name: string;
  /** The raw metric value this component scored. */
  raw: number;
  /** The 0–10 sub-score. */
  score: number;
  /** Optional human note — e.g. the D-003 pairing that discounted it. */
  note?: string;
}

/** One scored axis (efficiency or speed): its aggregate 0–10 score + the components + a `why`. */
export interface HiveAxisScore {
  axis: 'efficiency' | 'speed';
  /** Weighted-aggregate 0–10 score. */
  score: number;
  /** Which metric drove the axis — the lowest-scoring component (what held it back). */
  why: string;
  components: ScoreComponent[];
}

/**
 * The deterministic floor (P-041): the un-gameable signals (computed, never self-reported) and
 * the CEILING they impose on the composite — the part an LLM judge cannot soften.
 */
export interface DeterministicFloor {
  /** A pre-existing green baseline test flipped red (`regressionsFromTests`). true = bad. */
  regressions: boolean;
  /** A reviewer referenced the planted defect's location (`plantedBugCaught`). */
  plantedBugCaught: boolean;
  /** A claimed-done item ground truth contradicts (`fabricationDetected`). true = bad. */
  fabricationDetected: boolean;
  /** wall-clock ÷ computed ideal — the COMPUTED speed signal (never self-reported, D-004). */
  criticalPathRatio: number;
  /** The 0–10 ceiling these signals impose on the composite (the judge cannot exceed it). */
  ceiling: number;
  /** Why the ceiling is where it is. */
  why: string;
}

/** The full scored verdict for one run under one rubric. */
export interface HiveScore {
  /** The rubric's cache key — `(run_id, rubric_hash)` is the score store PK. */
  rubricHash: string;
  rubricVersion: string;
  /** D-002: did the run do a GOOD job? Efficiency/speed credit is zero unless this holds. */
  outcomeGatePassed: boolean;
  /** Why the gate passed or failed (which condition). */
  gateReason: string;
  efficiency: HiveAxisScore;
  speed: HiveAxisScore;
  /** The deterministic floor (P-041) — the un-gameable ceiling. */
  floor: DeterministicFloor;
  /**
   * The final 0–10 composite: 0 when the outcome gate fails; otherwise the weighted efficiency +
   * speed aggregate, CAPPED by the deterministic floor ceiling. Computed purely from MEASURED
   * metrics — the LLM judge cannot raise it.
   */
  composite: number;
  /**
   * The optional LLM-judge composite (from {@link OutcomeMetrics.judge}) — ADVISORY only. Recorded
   * for observability + comparison; it NEVER feeds {@link HiveScore.composite} (P-041: the floor
   * the judge cannot soften).
   */
  judgeComposite?: number;
}

// ───────────────────────────── rubric hash ─────────────────────────────

/**
 * Canonical sha256 over everything in the rubric that would change a score — built field-by-field
 * in a fixed order so object key ordering of the input never affects the hash (mirrors the
 * eval-battery `rubricHash`). Cached scores under an old hash are never mixed with a new rubric.
 */
export function hiveScoreRubricHash(r: HiveScoreRubric): string {
  const t = r.thresholds;
  const payload = JSON.stringify({
    version: r.version,
    axisWeights: { efficiency: r.axisWeights.efficiency, speed: r.axisWeights.speed },
    efficiencyWeights: {
      parallelism: r.efficiencyWeights.parallelism,
      communication: r.efficiencyWeights.communication,
      rework: r.efficiencyWeights.rework,
      cost: r.efficiencyWeights.cost,
      queenCache: r.efficiencyWeights.queenCache,
      queenRoundTrip: r.efficiencyWeights.queenRoundTrip,
      beeCarry: r.efficiencyWeights.beeCarry,
    },
    speedWeights: {
      criticalPath: r.speedWeights.criticalPath,
      firstPlacement: r.speedWeights.firstPlacement,
      stuck: r.speedWeights.stuck,
    },
    thresholds: {
      communicationOverheadCeiling: t.communicationOverheadCeiling,
      collisionRateCeiling: t.collisionRateCeiling,
      uselessBeeRateCeiling: t.uselessBeeRateCeiling,
      reworkRateCeiling: t.reworkRateCeiling,
      costPerItemUsdCeiling: t.costPerItemUsdCeiling,
      queenTurnsPerWakeCeiling: t.queenTurnsPerWakeCeiling,
      beeCarryShareCeiling: t.beeCarryShareCeiling,
      criticalPathRatioCeiling: t.criticalPathRatioCeiling,
      timeToFirstPlacementMsCeiling: t.timeToFirstPlacementMsCeiling,
      maxStuckMsCeiling: t.maxStuckMsCeiling,
      regressionCompositeCeiling: t.regressionCompositeCeiling,
    },
  });
  return createHash('sha256').update(payload).digest('hex');
}

// ───────────────────────────── normalization cores (pure) ─────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

/** A [0,1] higher-is-better metric → 0–10. */
const scoreHigher01 = (v: number): number => clamp01(v) * 10;

/** A lower-is-better metric → 10 at 0, 0 at (and past) `ceiling`. A non-positive ceiling: 0⇒10 else 0. */
function scoreLowerBetter(v: number, ceiling: number): number {
  if (!(ceiling > 0)) return v <= 0 ? 10 : 0;
  return clamp01((ceiling - v) / ceiling) * 10;
}

/**
 * The D-003 pairing-credit factor in [0,1]: a paired failure-rate vs its ceiling. 1 when there is
 * no failure, 0 at/past the ceiling. Multiplying a win by this is what makes "efficient" require
 * "and effective" — a win achieved by causing its paired failure earns nothing.
 */
function pairCredit(failure: number, ceiling: number): number {
  if (!(ceiling > 0)) return failure <= 0 ? 1 : 0;
  return clamp01(1 - failure / ceiling);
}

/**
 * Critical-path ratio → 0–10: ratio ≤ 1 ⇒ 10 (optimally parallel — as fast as the work is deep),
 * `ceiling` ⇒ 0 (badly serialized). The D-004 discriminator: a serialized run on the same
 * scenario scores low while a genuinely-deep run scores high.
 */
function scoreCriticalPathRatio(ratio: number, ceiling: number): number {
  if (!(ceiling > 1)) return ratio <= 1 ? 10 : 0;
  return clamp01((ceiling - Math.max(1, ratio)) / (ceiling - 1)) * 10;
}

/** Weighted aggregate of components by a parallel weights record; ignores zero-weight components. */
function weightedAggregate(components: ScoreComponent[], weights: number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < components.length; i++) {
    const w = weights[i] ?? 0;
    if (w <= 0) continue;
    num += components[i].score * w;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/** The component that held an axis back (lowest score) — the axis's `why`. */
function driverWhy(axis: string, components: ScoreComponent[]): string {
  if (components.length === 0) return `${axis}: no components`;
  const lowest = components.reduce((a, b) => (b.score < a.score ? b : a));
  return `${axis} driven by ${lowest.name} (${lowest.score.toFixed(1)}/10${lowest.note ? `, ${lowest.note}` : ''})`;
}

// ───────────────────────────── the scorer ─────────────────────────────

/** Score the efficiency axis — each win discounted by its D-003 paired failure. */
function scoreEfficiency(eff: EfficiencyMetrics, r: HiveScoreRubric): HiveAxisScore {
  const t = r.thresholds;

  // High-parallelism, discounted by useless-bee rate (D-003): util only counts if bees did work.
  const parallelismBase = scoreHigher01(eff.parallelismUtilization);
  const uselessCredit = pairCredit(eff.uselessBeeRate, t.uselessBeeRateCeiling);
  const parallelism: ScoreComponent = {
    name: 'parallelism',
    raw: eff.parallelismUtilization,
    score: parallelismBase * uselessCredit,
    note: `×${uselessCredit.toFixed(2)} useless-bee credit (rate ${eff.uselessBeeRate.toFixed(2)})`,
  };

  // Low-communication, discounted by collision rate (D-003): cheap comms only count if no collisions.
  const commBase = scoreLowerBetter(eff.communicationOverhead, t.communicationOverheadCeiling);
  const collisionCredit = pairCredit(eff.collisionRate, t.collisionRateCeiling);
  const communication: ScoreComponent = {
    name: 'communication',
    raw: eff.communicationOverhead,
    score: commBase * collisionCredit,
    note: `×${collisionCredit.toFixed(2)} collision credit (rate ${eff.collisionRate.toFixed(2)})`,
  };

  const rework: ScoreComponent = {
    name: 'rework',
    raw: eff.reworkRate,
    score: scoreLowerBetter(eff.reworkRate, t.reworkRateCeiling),
  };
  const cost: ScoreComponent = {
    name: 'cost',
    raw: eff.costPerItemUsd,
    score: scoreLowerBetter(eff.costPerItemUsd, t.costPerItemUsdCeiling),
  };

  const components = [parallelism, communication, rework, cost];
  const weights = [
    r.efficiencyWeights.parallelism,
    r.efficiencyWeights.communication,
    r.efficiencyWeights.rework,
    r.efficiencyWeights.cost,
  ];

  // The D-003 rework credit, shared by the queen AND bee per-wake wins below: each is discounted by
  // it because a cache/round-trip/carry "win" bought by reusing or dropping STALE working state
  // (not re-deriving / preserving the current frontier) surfaces as re-placements/bounces.
  const reworkCredit = pairCredit(eff.reworkRate, t.reworkRateCeiling);

  // Queen per-wake efficiency (B-06) — scored ONLY when the run carried Queen-wake samples, so a run
  // without them keeps the original four-component axis (no false 0 for a cache ratio never earned).
  // Both queen wins are D-003-paired with rework: a cache/round-trip "win" bought by reusing STALE
  // state (not re-deriving the current frontier) surfaces as re-placements/bounces, which zeros it.
  if (eff.queenWakes > 0) {
    // Win-1: frozen-prefix cache-hit ratio (higher = better), discounted by rework.
    components.push({
      name: 'queenCache',
      raw: eff.cacheHitRatio,
      score: scoreHigher01(eff.cacheHitRatio) * reworkCredit,
      note: `×${reworkCredit.toFixed(2)} rework credit (Queen cache-hit ratio, Win-1)`,
    });
    weights.push(r.efficiencyWeights.queenCache);
    // Win-2: turns/wake (lower = better) — only when a wake reported a turn count.
    if (eff.avgQueenTurns != null) {
      components.push({
        name: 'queenRoundTrip',
        raw: eff.avgQueenTurns,
        score: scoreLowerBetter(eff.avgQueenTurns, t.queenTurnsPerWakeCeiling) * reworkCredit,
        note: `×${reworkCredit.toFixed(2)} rework credit (Queen turns/wake, Win-2 round-trips)`,
      });
      weights.push(r.efficiencyWeights.queenRoundTrip);
    }
  }

  // Bee warm-inject carry efficiency (P-015 — the bee analog of the queen per-wake wins) — scored
  // ONLY when the run actually warm-injected bees (beeWarmInjects > 0), so a run with no warm-inject
  // carry keeps its prior axis (no false 0 for carry it never incurred). LOWER carry share is better:
  // the carry is dead prior-task transcript re-read every turn (D-011); the Phase-1 fresh-context
  // fork drops it → this sub-score RISES, making the before/after win VISIBLE (D-006). D-003-paired
  // with rework — a carry drop bought by dropping live working state mid-task shows up as redo.
  if (eff.beeWarmInjects > 0) {
    components.push({
      name: 'beeCarry',
      raw: eff.beeCarryShare,
      score: scoreLowerBetter(eff.beeCarryShare, t.beeCarryShareCeiling) * reworkCredit,
      note: `×${reworkCredit.toFixed(2)} rework credit (bee warm-inject carry share, lower=fresher)`,
    });
    weights.push(r.efficiencyWeights.beeCarry);
  }

  return {
    axis: 'efficiency',
    score: weightedAggregate(components, weights),
    why: driverWhy('efficiency', components),
    components,
  };
}

/** Score the speed axis — the critical-path ratio is primary (the computed, un-gameable signal). */
function scoreSpeed(speed: SpeedMetrics, r: HiveScoreRubric): HiveAxisScore {
  const t = r.thresholds;
  const criticalPath: ScoreComponent = {
    name: 'criticalPathRatio',
    raw: speed.criticalPathRatio,
    score: scoreCriticalPathRatio(speed.criticalPathRatio, t.criticalPathRatioCeiling),
    note: `ideal ${speed.idealWallClockMs}ms, measured ${speed.wallClockMs}ms`,
  };
  const firstPlacement: ScoreComponent = {
    name: 'timeToFirstPlacement',
    raw: speed.timeToFirstPlacementMs,
    score: scoreLowerBetter(speed.timeToFirstPlacementMs, t.timeToFirstPlacementMsCeiling),
  };
  const stuck: ScoreComponent = {
    name: 'maxStuck',
    raw: speed.maxStuckMs,
    score: scoreLowerBetter(speed.maxStuckMs, t.maxStuckMsCeiling),
  };
  const components = [criticalPath, firstPlacement, stuck];
  const weights = [r.speedWeights.criticalPath, r.speedWeights.firstPlacement, r.speedWeights.stuck];
  return {
    axis: 'speed',
    score: weightedAggregate(components, weights),
    why: driverWhy('speed', components),
    components,
  };
}

/** The outcome gate (D-002) + its human reason. */
function evaluateGate(outcome: OutcomeMetrics): { passed: boolean; reason: string } {
  if (outcome.outcomeGatePassed) {
    return { passed: true, reason: 'outcome gate passed: acceptance + planted-bug-caught + no fabrication' };
  }
  const failures: string[] = [];
  if (!outcome.acceptancePass) failures.push('acceptance failed');
  if (!outcome.plantedBugCaught) failures.push('planted bug missed');
  if (outcome.fabrication.detected) {
    failures.push(`fabricated DONE (${outcome.fabrication.fabricatedItems.join(', ') || 'items'})`);
  }
  return { passed: false, reason: `outcome gate failed: ${failures.join('; ') || 'unknown'}` };
}

/** The deterministic floor (P-041): the un-gameable signals + the ceiling they impose. */
function evaluateFloor(outcome: OutcomeMetrics, speed: SpeedMetrics, r: HiveScoreRubric): DeterministicFloor {
  // Above the gate, a regression is the signal the judge cannot soften — it caps the composite.
  const ceiling = outcome.regressions ? r.thresholds.regressionCompositeCeiling : 10;
  const why = outcome.regressions
    ? `regression of a pre-existing green test caps composite at ${ceiling}/10`
    : 'no deterministic-floor penalty';
  return {
    regressions: outcome.regressions,
    plantedBugCaught: outcome.plantedBugCaught,
    fabricationDetected: outcome.fabrication.detected,
    criticalPathRatio: speed.criticalPathRatio,
    ceiling,
    why,
  };
}

/**
 * Compute the composite score for one run from its three metric bundles. Pure + deterministic.
 *
 * The shape (D-002 + P-041):
 *   1. outcome gate fails  → composite 0 (efficiency/speed credit zeroed).
 *   2. outcome gate passes → composite = weighted(efficiency, speed), then CAPPED by the
 *      deterministic floor ceiling (a regression caps it). The LLM judge composite is recorded
 *      advisory-only and never raises the score.
 */
export function computeHiveScore(
  outcome: OutcomeMetrics,
  efficiency: EfficiencyMetrics,
  speed: SpeedMetrics,
  rubric: HiveScoreRubric = DEFAULT_HIVE_SCORE_RUBRIC_V1,
): HiveScore {
  const gate = evaluateGate(outcome);
  const effAxis = scoreEfficiency(efficiency, rubric);
  const speedAxis = scoreSpeed(speed, rubric);
  const floor = evaluateFloor(outcome, speed, rubric);

  let composite = 0;
  if (gate.passed) {
    const raw = weightedAggregate(
      [
        { name: 'efficiency', raw: effAxis.score, score: effAxis.score },
        { name: 'speed', raw: speedAxis.score, score: speedAxis.score },
      ],
      [rubric.axisWeights.efficiency, rubric.axisWeights.speed],
    );
    composite = Math.min(raw, floor.ceiling);
  }

  return {
    rubricHash: hiveScoreRubricHash(rubric),
    rubricVersion: rubric.version,
    outcomeGatePassed: gate.passed,
    gateReason: gate.reason,
    efficiency: effAxis,
    speed: speedAxis,
    floor,
    composite,
    judgeComposite: outcome.judge?.composite,
  };
}

/**
 * Flatten a {@link HiveScore} into the persisted {@link HiveEvalScoreRow} for one run — the bridge
 * the battery / live-run wiring (HE-07, owner-gated P-051) hands to {@link HiveEvalStore.upsertScore}.
 * The whole score is kept in `detail`; the headline + the deterministic-floor signals are promoted
 * to columns for indexable trend reads.
 */
export function hiveScoreToRow(runId: string, score: HiveScore): HiveEvalScoreRow {
  return {
    runId,
    rubricHash: score.rubricHash,
    rubricVersion: score.rubricVersion,
    outcomeGatePassed: score.outcomeGatePassed,
    efficiencyScore: score.efficiency.score,
    speedScore: score.speed.score,
    composite: score.composite,
    judgeComposite: score.judgeComposite,
    regressions: score.floor.regressions,
    plantedBugCaught: score.floor.plantedBugCaught,
    fabricationDetected: score.floor.fabricationDetected,
    criticalPathRatio: score.floor.criticalPathRatio,
    floorCeiling: score.floor.ceiling,
    detail: score,
  };
}
