/**
 * Run validity signals — the integrity guarantee (benchmark-evaluation-ui-2026-06-16
 * P-009 / D-003).
 *
 * The hardest-won lesson of the benchmark effort: a resolved% is only as honest as
 * its caveats (opus model-drift, queen reclaims, empty diffs counted as false, a
 * 0-work control that would fake a delta). This module computes, from a run's
 * metadata (+ optional LIVE fleet state during a run), the validity signals the UI
 * surfaces as red/green badges and that GATE whether a delta can be shown as
 * "valid" (isRunValid → no signal failed).
 *
 * Pure + dependency-free (mirrors the eval-viz convention) so it drives both the
 * live monitor badges (P-009) and the compare caveats (P-012), and is unit-tested
 * in isolation.
 */
export type ValidityStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export type ValidityKey =
  | 'opus-only'
  | 'queen-survival'
  | 'empty-diff'
  | 'generation-attributed'
  | 'fleet-cap'
  | 'subset-size'
  | 'single-seed';

export interface ValiditySignal {
  key: ValidityKey;
  label: string;
  status: ValidityStatus;
  detail: string;
}

/** Live fleet state during a run (from spawned_agents / agent_usage_samples).
 *  All fields null for a completed/imported run whose fleet is gone. */
export interface ValidityLiveFleet {
  queenAlive: boolean | null;
  queenAgeSec: number | null;
  queenReclaims: number | null;
  /** sonnet/haiku samples on any bee/queen — the model-drift leak. */
  nonOpusSamples: number | null;
  totalSamples: number | null;
}

export interface ValidityInput {
  taskCount: number;
  /** Tasks whose generated diff was non-empty (a real patch was produced). */
  nonEmptyDiffs: number;
  /** The fleet cap the run ran under (null = uncapped). */
  capValue?: number | null;
  /** The run used orphan-recovery / bee re-placement (a reclaim path ran). */
  recovered?: boolean;
  /** Count of RESOLVED tasks whose per-task generation telemetry is zero
   *  (turns=0 AND cost=0 AND tokensOut=0) — i.e. a non-empty, grade-passing diff
   *  with no recorded in-run model work. A "phantom win" (see generation-attributed
   *  signal). Undefined = the per-task generation breakdown wasn't supplied. */
  resolvedZeroGen?: number;
  /** Independent attempts of the run (1 = single-seed). */
  seedCount?: number;
  /** Live fleet signals (only present during a run). */
  live?: ValidityLiveFleet | null;
}

/** A subset >= this is treated as a stable single-number suite; below it the
 *  number is indicative, not definitive (the m3 pilot is 11). */
export const SUBSET_STABLE_MIN = 100;
/** A queen must survive past this (no reclaim) to count as a real Queen run. */
export const QUEEN_SURVIVAL_SEC = 300;

export function computeValiditySignals(input: ValidityInput): ValiditySignal[] {
  const { taskCount, nonEmptyDiffs } = input;
  const emptyDiff = Math.max(0, taskCount - nonEmptyDiffs);
  const seedCount = input.seedCount ?? 1;
  const live = input.live ?? null;

  // OPUS-ONLY — no sonnet/haiku leak on any bee/queen (D-027). Needs live samples.
  let opusOnly: ValiditySignal;
  if (live && live.nonOpusSamples != null) {
    opusOnly =
      live.nonOpusSamples === 0
        ? { key: 'opus-only', label: 'Opus-only', status: 'pass', detail: 'every sampled agent ran opus' }
        : {
            key: 'opus-only',
            label: 'Opus-only',
            status: 'fail',
            detail: `${live.nonOpusSamples} non-opus sample(s) leaked (sonnet/haiku) — model drift contaminates the result`,
          };
  } else {
    opusOnly = { key: 'opus-only', label: 'Opus-only', status: 'unknown', detail: 'model-leak check needs the live fleet samples' };
  }

  // QUEEN-SURVIVAL — no reclaim, age > 300s (a re-woken/reclaimed queen ≠ a real Queen run).
  let queenSurvival: ValiditySignal;
  if (live && live.queenAlive != null) {
    if (live.queenAlive === false) {
      queenSurvival = { key: 'queen-survival', label: 'Mug survival', status: 'fail', detail: 'the Mug was reclaimed/died — not a real-Mug run' };
    } else if ((live.queenReclaims ?? 0) > 0) {
      queenSurvival = { key: 'queen-survival', label: 'Mug survival', status: 'fail', detail: `${live.queenReclaims} Mug reclaim(s) — the orchestration was interrupted` };
    } else if ((live.queenAgeSec ?? 0) < QUEEN_SURVIVAL_SEC) {
      queenSurvival = { key: 'queen-survival', label: 'Mug survival', status: 'warn', detail: `Mug age ${live.queenAgeSec ?? 0}s < ${QUEEN_SURVIVAL_SEC}s — too early to confirm survival` };
    } else {
      queenSurvival = { key: 'queen-survival', label: 'Mug survival', status: 'pass', detail: `survived ${live.queenAgeSec}s, 0 reclaims` };
    }
  } else {
    queenSurvival = { key: 'queen-survival', label: 'Mug survival', status: 'unknown', detail: 'survival check needs the live fleet' };
  }

  // EMPTY-DIFF — empty diffs are counted as unresolved (never silently). ALL-empty
  // is a degenerate arm that did no model work → fail (the 0-work-control refusal, D-003).
  let emptyDiffSig: ValiditySignal;
  if (emptyDiff === 0) {
    emptyDiffSig = { key: 'empty-diff', label: 'Non-empty diffs', status: 'pass', detail: 'every task produced a patch' };
  } else if (emptyDiff === taskCount) {
    emptyDiffSig = { key: 'empty-diff', label: 'Non-empty diffs', status: 'fail', detail: '0 non-empty diffs — the arm did no model work; not a valid result' };
  } else {
    emptyDiffSig = { key: 'empty-diff', label: 'Non-empty diffs', status: 'warn', detail: `${emptyDiff}/${taskCount} task(s) produced an empty diff (counted as unresolved)` };
  }

  // GENERATION-ATTRIBUTED — every RESOLVED task must trace to a real in-run model
  // generation. A non-empty, grade-passing diff with turns=0 AND cost=0 AND tokensOut=0
  // (the recovery / re-placement path) is a "phantom win": it inflates resolved% with
  // work the run never measured, and it slips past BOTH opus-only (no live samples →
  // unknown, not fail) AND empty-diff (the diff is non-empty). This is the gap that hid
  // the m3 protonmail+qutebrowser wins (2 of 6) — see benchmark-credibility-roadmap D-027.
  let genAttributed: ValiditySignal;
  if (input.resolvedZeroGen != null) {
    genAttributed =
      input.resolvedZeroGen === 0
        ? { key: 'generation-attributed', label: 'Generation-attributed', status: 'pass', detail: 'every resolved task traces to a recorded in-run generation' }
        : {
            key: 'generation-attributed',
            label: 'Generation-attributed',
            status: 'fail',
            detail: `${input.resolvedZeroGen} resolved task(s) have zero recorded generation (turns=0, cost=0, 0 tokens) — phantom win(s): the diff graded as resolved but no in-run model work is accounted, so resolved% is inflated`,
          };
  } else if (input.recovered) {
    genAttributed = {
      key: 'generation-attributed',
      label: 'Generation-attributed',
      status: 'warn',
      detail: 'run used orphan-recovery / re-placement but the per-task generation breakdown was not supplied — recovered wins may be unattributed (phantom-win risk); supply resolvedZeroGen to confirm',
    };
  } else {
    genAttributed = { key: 'generation-attributed', label: 'Generation-attributed', status: 'unknown', detail: 'per-task generation attribution not supplied' };
  }

  // FLEET-CAP — an uncapped run has no contention control (the Queen makes no sequencing decision).
  const cap = input.capValue ?? null;
  const fleetCap: ValiditySignal =
    cap != null
      ? { key: 'fleet-cap', label: 'Fleet cap', status: 'pass', detail: `cap ${cap}` }
      : { key: 'fleet-cap', label: 'Fleet cap', status: 'warn', detail: 'uncapped — contention not controlled' };

  // SUBSET-SIZE — a small subset is indicative, not definitive.
  const subsetSize: ValiditySignal =
    taskCount >= SUBSET_STABLE_MIN
      ? { key: 'subset-size', label: 'Subset size', status: 'pass', detail: `${taskCount} tasks` }
      : { key: 'subset-size', label: 'Subset size', status: 'warn', detail: `subset of ${taskCount} tasks — indicative, not the full set` };

  // SINGLE-SEED — single-seed variance is uncaptured.
  const singleSeed: ValiditySignal =
    seedCount >= 3
      ? { key: 'single-seed', label: 'Seeds', status: 'pass', detail: `${seedCount} seeds` }
      : { key: 'single-seed', label: 'Seeds', status: 'warn', detail: `${seedCount} seed — single-seed variance not captured` };

  return [opusOnly, queenSurvival, emptyDiffSig, genAttributed, fleetCap, subsetSize, singleSeed];
}

/** A run's result may be presented as "valid" only when no signal FAILED
 *  (warn/unknown are honest caveats, not invalidating). The D-003 gate. */
export function isRunValid(signals: readonly ValiditySignal[]): boolean {
  return !signals.some((s) => s.status === 'fail');
}

/** The signals that are not clean (warn/fail) — the caveats to surface on a delta. */
export function validityCaveats(signals: readonly ValiditySignal[]): ValiditySignal[] {
  return signals.filter((s) => s.status === 'warn' || s.status === 'fail');
}
