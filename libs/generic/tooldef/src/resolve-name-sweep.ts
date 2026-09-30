/**
 * (T, M) calibration sweep for fuzzy tool-name resolution (plan
 * `fuzzy-tool-name-resolution-2026-07-02`, P-003). Pure evaluation over the two committed
 * corpora — the vitest (`resolve-name-sweep.test.ts`) pins the frozen constants to this
 * function's optimum, so the constants cannot drift from the evidence that chose them.
 *
 * Population definitions (what each counter means):
 *  - golden        — P-001 `GOLDEN_MANGLES`; must resolve to `intendedTool`.
 *      `recoveredStage1` = distance 0 after canonicalize (needs no T/M);
 *      `recoveredFuzzy`  = resolved by the threshold gate at (T,M) with the right tool;
 *      `wrong`           = resolved to the WRONG tool (worse than abstaining — counted as a false-resolve).
 *  - hardAdversarial — P-002 tie + far-synonym cases; a resolve of ANY kind is a false-resolve.
 *  - marginAdversarial — P-002 margin probes; a resolve onto a mutating-looking tool
 *      (`looksMutating`) is a false-resolve unless the D-007 tier gate blocks it (the sweep
 *      applies the gate, so these count only when the target is NOT tier-blocked).
 *  - nonMangles    — P-001 `REAL_NON_MANGLES`; must never resolve.
 */
import {
  GOLDEN_MANGLES,
  REAL_NON_MANGLES,
  SPINE_TOOLS,
  type MangleCase,
} from './resolve-name-corpus';
import {
  ADVERSARIAL_CASES,
  ADVERSARIAL_UNIVERSE,
  looksMutating,
} from './resolve-name-adversarial-corpus';
import { matchName, type MatchOutcome } from './resolve-name-match';

/**
 * Candidate set for the golden + non-mangle populations: the spine, the adversarial
 * universe (every catalog name involved in a near-collision — the realistic neighbours),
 * and each golden case's intended tool (a mangle can target a non-spine tool).
 */
export const GOLDEN_CANDIDATES: readonly string[] = [
  ...new Set([...SPINE_TOOLS, ...ADVERSARIAL_UNIVERSE, ...GOLDEN_MANGLES.map((c) => c.intendedTool)]),
];

export interface SweepPoint {
  readonly T: number;
  readonly M: number;
  readonly goldenTotal: number;
  readonly recoveredStage1: number;
  readonly recoveredFuzzy: number;
  readonly goldenWrong: number;
  readonly goldenAbstained: number;
  /** of `goldenAbstained`: unique fuzzy hit on a high-tier tool, withheld by D-007 (correct, not a miss) */
  readonly goldenBlocked: number;
  readonly hardFalseResolves: number;
  readonly marginFalseResolves: number;
  readonly nonMangleFalseResolves: number;
  /** total false-resolves across every population above (the safety bar is 0) */
  readonly falseResolves: number;
  /** stage-1 + fuzzy recoveries */
  readonly recovered: number;
}

/** A resolve = the matcher would dispatch (exact or fuzzy); ambiguous/blocked/none abstain. */
const resolvedTool = (o: MatchOutcome): string | null => (o.kind === 'exact' || o.kind === 'fuzzy' ? o.tool : null);

/** D-007 proxy for the sweep: the corpus's own mutating-verb heuristic stands in for `tierFor`. */
export const isHighTierProxy = looksMutating;

export function evaluate(T: number, M: number, golden: readonly MangleCase[] = GOLDEN_MANGLES): SweepPoint {
  const params = { T, M };
  let recoveredStage1 = 0;
  let recoveredFuzzy = 0;
  let goldenWrong = 0;
  let goldenAbstained = 0;
  let goldenBlocked = 0;
  for (const c of golden) {
    // D-007 applies to golden too: a mangle of a mutating tool is *expected* to abstain on the
    // fuzzy path, so stage-1 (exact) recoveries are counted but a high-tier fuzzy one is not.
    const o = matchName(c.rawInput, GOLDEN_CANDIDATES, params, isHighTierProxy);
    const got = resolvedTool(o);
    if (o.kind === 'blocked-high-tier') goldenBlocked++;
    if (got === null) goldenAbstained++;
    else if (got !== c.intendedTool) goldenWrong++;
    else if (o.kind === 'exact') recoveredStage1++;
    else recoveredFuzzy++;
  }

  let hardFalseResolves = 0;
  let marginFalseResolves = 0;
  for (const c of ADVERSARIAL_CASES) {
    const o = matchName(c.rawInput, c.candidates, params, isHighTierProxy);
    const got = resolvedTool(o);
    if (got === null) continue;
    if (c.hard) hardFalseResolves++;
    else if (looksMutating(got)) marginFalseResolves++; // unreachable while the gate blocks high tier; kept as the tripwire
  }

  let nonMangleFalseResolves = 0;
  for (const n of REAL_NON_MANGLES) {
    if (resolvedTool(matchName(n.rawInput, GOLDEN_CANDIDATES, params, isHighTierProxy)) !== null) nonMangleFalseResolves++;
  }

  return {
    T,
    M,
    goldenTotal: golden.length,
    recoveredStage1,
    recoveredFuzzy,
    goldenWrong,
    goldenAbstained,
    goldenBlocked,
    hardFalseResolves,
    marginFalseResolves,
    nonMangleFalseResolves,
    falseResolves: goldenWrong + hardFalseResolves + marginFalseResolves + nonMangleFalseResolves,
    recovered: recoveredStage1 + recoveredFuzzy,
  };
}

/** Round to 3 dp so grid keys are stable (0.06 + 0.02 float drift). */
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const T_GRID: readonly number[] = Array.from({ length: 26 }, (_, i) => r3(i * 0.02)); // 0 .. 0.50
/** RAW-edit margins (the matcher judges uniqueness on raw edits, not normalized). */
export const M_GRID: readonly number[] = [1, 2, 3, 4];

export function sweep(): SweepPoint[] {
  const out: SweepPoint[] = [];
  for (const T of T_GRID) for (const M of M_GRID) out.push(evaluate(T, M));
  return out;
}

/**
 * The choice rule: among points with ZERO false-resolves, maximise `recovered`; break ties
 * toward the MOST CONSERVATIVE point (smallest T, then largest M) — a tie in evidence must
 * not buy extra permissiveness.
 */
export function pickBest(points: readonly SweepPoint[]): SweepPoint | null {
  const safe = points.filter((p) => p.falseResolves === 0);
  if (safe.length === 0) return null;
  return [...safe].sort((a, b) => b.recovered - a.recovered || a.T - b.T || b.M - a.M)[0]!;
}
