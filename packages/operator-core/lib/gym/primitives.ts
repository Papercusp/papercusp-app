/**
 * Gym ENGINE-PRIMITIVES surface (harness-blueprint-orchestration-2026-06-03 P-012 /
 * D-022).
 *
 * The gym is now a blueprint (the `gym` built-in), and its roles drive optimization
 * by calling the gym's primitives. This module is the single, stable import surface
 * those primitives are re-exposed through — so the `gym:*` agent tools, the A/B
 * eval-matrix (P-013), and any future gym wiring import from ONE place instead of
 * reaching into a dozen `lib/gym/*` cores.
 *
 * Two things live HERE (not just re-exports), because they are the host-side
 * resolution the blueprint engine needs by NAME:
 *
 *   1. The SIGNAL REGISTRY — `blueprint.gym.signals` is a `string[]` of signal
 *      names; this resolves each name to its deterministic, un-gameable guardrail
 *      (`regressionsFromTests`, `plantedBugCaught`) under one uniform interface so
 *      a target blueprint's declared signals can be evaluated host-side (D-011/D-015).
 *   2. The RUBRIC MAPPER — `rubricFromBlueprintGym` maps the engine's schema-shaped
 *      `blueprint.gym.rubric` (loose `GymRubricSchema`) onto the concrete frozen
 *      `GymJudgeRubric` the judge runs, falling back to `GYM_JUDGE_RUBRIC_V1` per
 *      field. This is how the judge reads the *target's* rubric (D-022).
 *
 * Pure — no I/O, no PG, no LLM. The heavy primitives it re-exports take their
 * effects injected (an `llmCall`, a `Sql`, runner ports), so this surface stays
 * unit-testable without the network.
 */
import {
  GYM_JUDGE_RUBRIC_V1,
  type GymJudgeRubric,
  type DimensionWeights,
} from './judge-scoring';
import { regressionsFromTests, plantedBugCaught, fabricationFromClaims, type TestResult, type ClaimedItemTruth } from './signals';
import {
  drillResolveRate,
  drillTriageAccuracy,
  drillMttshMs,
  DRILL_RESOLVE_RATE_FLOOR,
  DRILL_TRIAGE_ACCURACY_FLOOR,
  DRILL_MTTSH_CEILING_MS,
  type DrillOutcome,
} from './drill-signals';
import type { PlantedBug } from './probe-generator';
import { resolveChildBlueprint, assertNotNestedHive } from '@papercusp/orchestrator/blueprint';

// ───────────────────────────── signal registry ─────────────────────────────

/**
 * Everything a deterministic signal might read about one gym run. Each signal pulls
 * only the fields it needs and reports `applicable:false` when they are absent —
 * so a `coding` target (test-based) and a `research` target (output-based) can each
 * declare the signals that make sense for it without the others erroring.
 */
export interface SignalContext {
  /** The repo's own tests, run BEFORE the harness's change (for regression detection). */
  preTests?: readonly TestResult[];
  /** The repo's own tests, run AFTER the harness's change. */
  postTests?: readonly TestResult[];
  /** The defect planted in the task (for the planted-bug-caught monitor), if any. */
  plantedBug?: PlantedBug | null;
  /** The harness's produced output text (validator/crosscheck verdicts, filed issues). */
  harnessOutputText?: string;
  /**
   * Drill-corpus outcomes for the run (FB-23 / P-048): the red-queen drills the
   * variant was exercised against, each carrying its planted known answer. Fed by
   * `readDrillOutcomes()` (lib/red-queen/store.ts) once the corpus is live.
   */
  drillOutcomes?: readonly DrillOutcome[];
  /**
   * Per-item claimed-vs-ground-truth rows for a WHOLE-HIVE run (hive-eval HE-06) — the
   * `fabricationDetected` signal reads these. Absent for single-harness gym targets (which have
   * no Hive-level DONE claims), so the signal reports `applicable:false` there, never a fake pass.
   */
  claimedItems?: readonly ClaimedItemTruth[];
}

export interface SignalResult {
  name: string;
  /**
   * The signal's raw boolean. Direction is signal-specific (the gym's gate logic
   * interprets it): `regressionsFromTests` true = a regression occurred (bad);
   * `plantedBugCaught` true = the harness caught the defect (good). Threshold
   * signals (the drill rates) report the SLO verdict here.
   */
  value: boolean;
  /** false when the context lacked the inputs this signal needs — a skip, not a real value. */
  applicable: boolean;
  /**
   * The underlying scalar for rate/duration signals (resolve rate, triage
   * accuracy, MTTSH ms) — observability + aggregation ride-along; `value` stays
   * the gate verdict. Absent on plain boolean signals.
   */
  metric?: number;
}

export type SignalFn = (ctx: SignalContext) => SignalResult;

/**
 * The host-side resolution of `blueprint.gym.signals` names → evaluators. These are
 * the un-gameable guardrails (D-011): the optimizer can touch neither the repo's own
 * tests nor the planted defect, so they are trustworthy monitors, never reward
 * targets. Add a new deterministic signal here to make it nameable from a blueprint.
 */
export const GYM_SIGNAL_REGISTRY: Readonly<Record<string, SignalFn>> = Object.freeze({
  regressionsFromTests: (ctx) => {
    if (!ctx.preTests || !ctx.postTests) {
      return { name: 'regressionsFromTests', value: false, applicable: false };
    }
    return { name: 'regressionsFromTests', value: regressionsFromTests(ctx.preTests, ctx.postTests), applicable: true };
  },
  plantedBugCaught: (ctx) => {
    if (!ctx.plantedBug || ctx.harnessOutputText == null) {
      return { name: 'plantedBugCaught', value: false, applicable: false };
    }
    return { name: 'plantedBugCaught', value: plantedBugCaught(ctx.plantedBug, ctx.harnessOutputText), applicable: true };
  },
  // fabricated-DONE detection (hive-eval HE-06, P-041): the worst autonomous-fleet failure made
  // un-gameable. `value:true` = a fabricated DONE was found (BAD, like regressionsFromTests).
  // Inapplicable (not a fake pass) when the context carries no Hive-level claim rows.
  fabricationDetected: (ctx) => {
    if (!ctx.claimedItems) return { name: 'fabricationDetected', value: false, applicable: false };
    return { name: 'fabricationDetected', value: fabricationFromClaims(ctx.claimedItems), applicable: true };
  },
  // ── drill-ground-truth signals (FB-23 / P-048) — the plantedBugCaught precedent
  // generalized: the drill corpus is planted, so its known answers are un-gameable.
  // Each reports the SLO verdict as `value` + the raw scalar as `metric`; a context
  // with no (settled/scoreable) drill rows is inapplicable, never a fake failure.
  drillResolveRate: (ctx) => {
    const rate = ctx.drillOutcomes ? drillResolveRate(ctx.drillOutcomes) : null;
    if (rate === null) return { name: 'drillResolveRate', value: false, applicable: false };
    return { name: 'drillResolveRate', value: rate >= DRILL_RESOLVE_RATE_FLOOR, applicable: true, metric: rate };
  },
  drillTriageAccuracy: (ctx) => {
    const acc = ctx.drillOutcomes ? drillTriageAccuracy(ctx.drillOutcomes) : null;
    if (acc === null) return { name: 'drillTriageAccuracy', value: false, applicable: false };
    return { name: 'drillTriageAccuracy', value: acc >= DRILL_TRIAGE_ACCURACY_FLOOR, applicable: true, metric: acc };
  },
  drillMttsh: (ctx) => {
    const ms = ctx.drillOutcomes ? drillMttshMs(ctx.drillOutcomes) : null;
    if (ms === null) return { name: 'drillMttsh', value: false, applicable: false };
    return { name: 'drillMttsh', value: ms <= DRILL_MTTSH_CEILING_MS, applicable: true, metric: ms };
  },
});

/** The signal names a blueprint may reference. */
export function knownSignals(): string[] {
  return Object.keys(GYM_SIGNAL_REGISTRY);
}

export interface ResolvedSignals {
  resolved: Array<{ name: string; fn: SignalFn }>;
  /** Names in the blueprint that no registered signal matches (an authoring smell). */
  unknown: string[];
}

/** Resolve a blueprint's declared signal names to their evaluators (+ report unknowns). */
export function resolveSignals(names: readonly string[]): ResolvedSignals {
  const resolved: Array<{ name: string; fn: SignalFn }> = [];
  const unknown: string[] = [];
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(GYM_SIGNAL_REGISTRY, name)) {
      resolved.push({ name, fn: GYM_SIGNAL_REGISTRY[name] });
    } else {
      unknown.push(name);
    }
  }
  return { resolved, unknown };
}

/**
 * Evaluate a target blueprint's declared signals over one run's context. Unknown
 * names are reported (not silently dropped) so a typo'd signal in a blueprint
 * surfaces. The results feed the gym's gate logic + the trace's `signals` summary.
 */
export function evaluateSignals(
  names: readonly string[],
  ctx: SignalContext,
): { results: SignalResult[]; unknown: string[] } {
  const { resolved, unknown } = resolveSignals(names);
  return { results: resolved.map(({ fn }) => fn(ctx)), unknown };
}

// ───────────────────────────── rubric mapper ─────────────────────────────

const DEFAULT_DIMS = GYM_JUDGE_RUBRIC_V1.dimensions;
const DEFAULT_WEIGHTS = GYM_JUDGE_RUBRIC_V1.weights;

/**
 * The (loose) rubric shape a target's `blueprint.gym.rubric` or an agent may supply —
 * every field optional; the mapper fills the rest from `GYM_JUDGE_RUBRIC_V1`. A full
 * `BlueprintGym.rubric` (whose `version` is required) is structurally assignable here.
 */
export interface GymRubricInput {
  version?: string;
  model?: string;
  temperature?: number;
  thinkingBudgetTokens?: number;
  weights?: Record<string, number>;
  dimensions?: Record<string, string>;
}

function pickWeight(w: Record<string, number> | undefined, key: keyof DimensionWeights): number {
  const v = w?.[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : DEFAULT_WEIGHTS[key];
}
function pickDim(d: Record<string, string> | undefined, key: 'd1' | 'd2' | 'd3'): string {
  const v = d?.[key];
  return typeof v === 'string' && v.length > 0 ? v : DEFAULT_DIMS[key];
}

/**
 * Map a target blueprint's (loose, schema-shaped) `blueprint.gym.rubric` onto the
 * concrete frozen `GymJudgeRubric` the judge runs. Every field falls back to
 * `GYM_JUDGE_RUBRIC_V1`, so a target that declares only `weights` (or no rubric at
 * all) still gets a complete, runnable rubric. This is the seam by which the judge
 * reads the TARGET's rubric (D-022) rather than a gym-side constant.
 */
export function rubricFromBlueprintGym(gym: { rubric?: GymRubricInput } | undefined): GymJudgeRubric {
  const r = gym?.rubric;
  if (!r) return GYM_JUDGE_RUBRIC_V1;
  return {
    version: r.version || GYM_JUDGE_RUBRIC_V1.version,
    model: r.model ?? GYM_JUDGE_RUBRIC_V1.model,
    temperature: typeof r.temperature === 'number' ? r.temperature : GYM_JUDGE_RUBRIC_V1.temperature,
    thinkingBudgetTokens:
      typeof r.thinkingBudgetTokens === 'number' ? r.thinkingBudgetTokens : GYM_JUDGE_RUBRIC_V1.thinkingBudgetTokens,
    weights: {
      d1: pickWeight(r.weights, 'd1'),
      d2: pickWeight(r.weights, 'd2'),
      d3: pickWeight(r.weights, 'd3'),
    },
    dimensions: {
      d1: pickDim(r.dimensions, 'd1'),
      d2: pickDim(r.dimensions, 'd2'),
      d3: pickDim(r.dimensions, 'd3'),
    },
  };
}

// ───────────────────────────── child-blueprint binding ─────────────────────────────

/**
 * Bind the gym's parameterized recursion child (D-008). The gym blueprint
 * declares `recursion.childBlueprint: $target`; at spawn time the gym runtime
 * resolves the actual child by binding `{ target: <blueprint-under-
 * optimization> }` through the engine's canonical `resolveChildBlueprint` —
 * the declared replacement for the former undeclared runtime override of
 * "self". Fail-closed: a gym blueprint whose `$target` can't bind throws
 * rather than silently running the gym against itself.
 *
 * The NO-NEST GUARD rides this recursion-resolution path (local-hive D-009 /
 * swarm D-018 enforcement A): when the resolved child is supplied (`childKind`),
 * a `kind:'hive'` child is REJECTED — a hive can never be a recursion child, only
 * a root. The gym only ever optimizes `kind:'harness'` targets, so the guard is a
 * structural backstop that fails loud if a hive id is ever bound as `$target`.
 * `childKind` is optional so the pure id-binding contract (used where the child's
 * kind isn't loaded) is unchanged.
 */
export function resolveGymChildBlueprint(
  gymBp: { id: string; recursion?: { childBlueprint?: string } },
  targetBlueprintId: string,
  childKind?: 'hive' | 'harness',
): string {
  const childId = resolveChildBlueprint(gymBp, { target: targetBlueprintId });
  // A bound recursion child IS a child (the gym is its parent) — guard it when
  // the caller knows the resolved child's kind.
  if (childKind !== undefined) assertNotNestedHive({ id: childId, kind: childKind }, true);
  return childId;
}

// ───────────────────────────── re-exports ─────────────────────────────
// The gym's primitives, surfaced from one module so the `gym:*` tools + the A/B
// eval-matrix import from here. Effects stay injected on the heavy ones.

export {
  judgeGymRun,
  buildJudgePrompt,
  type GymScore,
  type GymJudgeInput,
  type JudgeLlmCall,
} from './judge';
export {
  GYM_JUDGE_RUBRIC_V1,
  composite,
  rubricHash,
  parseJudgeOutput,
  type GymJudgeRubric,
  type DimensionWeights,
  type JudgeDimensionScores,
} from './judge-scoring';
export {
  regressionsFromTests,
  plantedBugCaught,
  type TestResult,
} from './signals';
export {
  drillResolveRate,
  drillTriageAccuracy,
  drillMttshMs,
  onlyDrillRows,
  DRILL_RESOLVE_RATE_FLOOR,
  DRILL_TRIAGE_ACCURACY_FLOOR,
  DRILL_MTTSH_CEILING_MS,
  type DrillOutcome,
} from './drill-signals';
export {
  collectTrace,
  assembleRawTrace,
  buildDiffCommand,
  type RunOutputRow,
  type CollectInput,
  type CollectDeps,
} from './collector';
export {
  runAbEvaluation,
  type AbConfig,
  type AbVariant,
  type AbTask,
  type AbResult,
  type AbRunOutcome,
  type AbDeps,
} from './ab-runner';
export type { PlantedBug } from './probe-generator';
// Quality-diversity archive (P-010, D-008) — the MAP-Elites novelty/diversity surface the
// gym-QD pieces consume (P-011 selection, P-012 Scout bridge, a gym read-tool). The PG store
// + recorder take an injected `Sql` (type-only import), so this surface stays runtime-pure.
export {
  describeBehavior,
  nicheKey,
  coordsToFeatures,
  featureDistance,
  noveltyFromMembers,
  GYM_NICHE_CELL_COUNT,
  SCOPE_BANDS,
  RISK_BANDS,
  DOMAIN_VOCAB,
  type NicheCoords,
  type BehaviorDescriptor,
  type ScopeBand,
  type RiskBand,
  type ArchiveSource,
  type ArchiveElite,
  type GymCandidate,
  type ArchiveCandidateRecord,
} from './qd/niche';
export {
  QdArchive,
  InMemoryArchiveStore,
  type ArchiveAPI,
  type ArchiveStore,
  type ArchiveCandidate,
  type UpsertResult,
  type CoverageStat,
} from './qd/archive';
export { PgArchiveStore } from './qd/archive-store-pg';
export { makeLoopArchiveRecorder, makeLoopQdSeams, makeGymArchive } from './qd/archive-recorder';
