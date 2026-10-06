/**
 * The whole-Hive (hive-eval) live-tier binding (`experiment-registry-invocation-api-
 * 2026-06-14` P-063, D-023 — the owner-requested un-staging of the D-022 deferral).
 * Mirrors the gym + instance bindings: the PURE transforms (`armToHiveCells`,
 * `hiveResultsToExperimentResult`) are fake-testable ($0); the LIVE `HiveRunPorts`
 * (boot/seed/drive/collect/teardown of a throwaway hive) is injected via `ctx.ports` and
 * is ABSENT until the owner arms it, so the hive tier stays STAGED (`run()` refuses).
 *
 * An arm varies the INSTANCE that drives a fixed scenario (the `['genome','model']`
 * slice): `genome.*` → a merged genome, `model.<role>` → spawn-time model overrides —
 * both carried on `HiveScenarioCell.variantConfig`, which the live `bootHive` applies
 * when it stands up the throwaway hive. The arms are scored by the SAME engine the
 * hive-eval loop uses: `runBattery` over `hiveScenarioSubject`, then `compareArms` ranks
 * the per-arm mean composite.
 */
import {
  BASELINE_ID,
  compareArms,
  runBattery,
  type BatteryCellResult,
  type BatteryRubric,
  type CompareArm,
  type CompareSelectResult,
  type JudgeLlmCall,
} from '@papercusp/eval-battery';
import {
  hiveScenarioSubject,
  type HiveRunHandle,
  type HiveRunPorts,
  type HiveRunSignals,
  type HiveScenarioCell,
} from '../pot-eval/run-harness';
import type { HiveScenario } from '../pot-eval/scenario';
import { mergeGenome, type Genome } from '../instance-spec/genome';
import { partitionArm, type KnobArm } from './knob-space';
import type { ExperimentArmResult, ExperimentRunResult } from './types';

const EMPTY_GENOME: Genome = { prompts: {}, config: {} };

/** The hive-specific battery input on the experiment request payload — the fixed scenario
 *  each arm's instance drives + the run caps + the judge rubric the hive-eval loop assembles. */
export interface HiveExperimentPayload {
  /** The fixed scenario every arm drives (the task); arms vary the instance, not this. */
  scenario: HiveScenario;
  /** The champion instance's genome; arms apply genome deltas to it (default empty). */
  baseGenome?: Genome;
  /** The frozen judge rubric (outcome × efficiency × speed). */
  rubric: BatteryRubric;
  seed?: number;
  budgetUsdCap?: number;
  beeCap?: number;
  /** Per-cell wall-clock bound (falls back to defaultTimeoutMs). */
  timeoutMs?: number;
  defaultTimeoutMs?: number;
}

const DEFAULTS = { seed: 1, budgetUsdCap: 5, beeCap: 4, defaultTimeoutMs: 30 * 60_000, maxDistillChars: 8000 };

/** One arm mapped onto its config-varied cells (one per repeat). The arm id is the
 *  grouping key (carried on the runId + the cell.instanceId). */
export interface HiveArmCells {
  armId: string;
  label: string;
  cells: { runId: string; cell: HiveScenarioCell }[];
}

/** Map an arm → its hive cells. `genome.*` merges onto the base genome; `model.<role>`
 *  becomes the cell's spawn-time `variantConfig.modelOverrides`; the empty-knobs arm is the
 *  unmodified champion. */
export function armToHiveCells(
  arm: KnobArm,
  payload: HiveExperimentPayload,
  repeats: number,
): HiveArmCells {
  const { genomeDelta, models } = partitionArm(arm);
  const hasGenome = Object.keys(genomeDelta).length > 0;
  const hasModels = Object.keys(models).length > 0;
  const variantConfig =
    hasGenome || hasModels
      ? {
          ...(hasGenome ? { genome: mergeGenome(payload.baseGenome ?? EMPTY_GENOME, genomeDelta) } : {}),
          ...(hasModels ? { modelOverrides: models } : {}),
        }
      : undefined;
  const cells = Array.from({ length: repeats }, (_, repeat) => ({
    runId: `${arm.id}::r${repeat}`,
    cell: {
      instanceId: arm.id,
      scenario: payload.scenario,
      repeat,
      seed: payload.seed ?? DEFAULTS.seed,
      budgetUsdCap: payload.budgetUsdCap ?? DEFAULTS.budgetUsdCap,
      beeCap: payload.beeCap ?? DEFAULTS.beeCap,
      ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
      ...(variantConfig ? { variantConfig } : {}),
    } satisfies HiveScenarioCell,
  }));
  return { armId: arm.id, label: arm.label ?? arm.id, cells };
}

/** Normalize the engine's per-cell results (grouped by arm) → the common
 *  ExperimentRunResult (per-arm mean composite + the compareArms verdict). */
export function hiveResultsToExperimentResult(
  armOrder: { armId: string; label: string }[],
  resultsByArm: Map<string, BatteryCellResult<HiveScenarioCell, HiveRunHandle, unknown>[]>,
): ExperimentRunResult {
  const arms: ExperimentArmResult[] = armOrder.map(({ armId, label }) => {
    const cells = resultsByArm.get(armId) ?? [];
    const scored = cells.filter((c) => c.status === 'scored' && c.score);
    const meanScore = scored.length ? scored.reduce((s, c) => s + (c.score?.composite ?? 0), 0) / scored.length : null;
    const costUsd = cells.reduce((s, c) => s + (c.handle?.costUsd ?? 0) + c.judgeCostUsd, 0);
    return { id: armId, label, meanScore, cells: cells.length, scored: scored.length, costUsd, costMeasured: cells.every((c) => c.judgeCostMeasured) };
  });
  const baseline = arms.find((a) => a.id === BASELINE_ID);
  const candidates = arms.filter((a) => a.id !== BASELINE_ID);
  const costMeasured = arms.every((a) => a.costMeasured);
  let comparison: Omit<CompareSelectResult, 'scenarioId'> | null = null;
  if (costMeasured && baseline && candidates.length > 0) {
    const toArm = (a: ExperimentArmResult): CompareArm => ({
      variantId: a.id,
      metrics: { composite: a.meanScore ?? undefined },
      ...(a.scored === 0 ? { error: 'no scored cells' } : {}),
    });
    comparison = compareArms({
      baseline: toArm(baseline),
      candidates: candidates.map(toArm),
      scorers: [{ id: 'composite', direction: 'higher-better' }],
      primary: 'composite',
    });
  }
  const scorecardVariantId = comparison?.selected ?? BASELINE_ID;
  const scored = (resultsByArm.get(scorecardVariantId) ?? []).filter((c) => c.status === 'scored' && c.score);
  const meanDimension = (dimension: 'd1' | 'd2' | 'd3'): number | null =>
    scored.length ? scored.reduce((sum, c) => sum + (c.score?.[dimension] ?? 0), 0) / scored.length : null;
  return {
    testId: 'hive',
    tier: 'live',
    baselineId: BASELINE_ID,
    arms,
    comparison,
    winner: comparison?.selected ?? null,
    totalCostUsd: arms.reduce((s, a) => s + a.costUsd, 0),
    costMeasured,
    budgetExhausted: false,
    scorecardScores: {
      outcome: costMeasured ? meanDimension('d1') : null,
      efficiency: costMeasured ? meanDimension('d2') : null,
      speed: costMeasured ? meanDimension('d3') : null,
    },
  };
}

export interface HiveExperimentRequest {
  batteryId: string;
  arms: KnobArm[];
  payload: HiveExperimentPayload;
  repeats: number;
  maxDistillChars?: number;
}

export interface HiveRunCoreCtx {
  workspaceId: string;
  now(): number;
  /** The frozen judge LLM client (shared across Subjects). */
  llmCall: JudgeLlmCall;
  /** The live HiveRunPorts (boot/seed/drive/collect/teardown). REQUIRED to execute — it
   *  stands up real hives + spends. Absent ⇒ the hive tier stays STAGED. */
  ports?: HiveRunPorts;
  sleep?(ms: number): Promise<void>;
}

export interface HiveRunCoreDeps {
  runBattery: typeof runBattery;
}
const defaultHiveDeps: HiveRunCoreDeps = { runBattery };

export async function hiveRunCore(
  request: HiveExperimentRequest,
  ctx: HiveRunCoreCtx,
  deps: HiveRunCoreDeps = defaultHiveDeps,
): Promise<ExperimentRunResult> {
  if (!ctx.ports) {
    throw new Error(
      'the hive tier requires ctx.hive.ports (the live hive-eval HiveRunPorts) — registered + mapped but STAGED until the owner arms it; its hive-eval loop drives it (experiment-registry-invocation-api P-063 / D-002 / D-017).',
    );
  }
  if (!request.payload?.scenario) throw new Error('hive request.payload.scenario (HiveScenario) is required');
  if (!request.payload?.rubric) throw new Error('hive request.payload.rubric (BatteryRubric) is required');

  const armCells = request.arms.map((a) => armToHiveCells(a, request.payload, request.repeats));
  // compareArms needs the baseline anchor — prepend the unmodified champion if absent.
  if (!armCells.some((a) => a.armId === BASELINE_ID)) {
    armCells.unshift(armToHiveCells({ id: BASELINE_ID, knobs: {} }, request.payload, request.repeats));
  }

  const runIdToArm = new Map<string, string>();
  const cells = armCells.flatMap((a) => {
    for (const c of a.cells) runIdToArm.set(c.runId, a.armId);
    return a.cells;
  });

  const opts = {
    defaultTimeoutMs: request.payload.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs,
    maxDistillChars: request.maxDistillChars ?? DEFAULTS.maxDistillChars,
  };
  const results = await deps.runBattery<HiveScenarioCell, HiveRunHandle, HiveRunSignals, unknown>(
    { cells, rubric: request.payload.rubric, maxDistillChars: opts.maxDistillChars, stopOnUnmeasuredJudgeCost: true },
    {
      subject: hiveScenarioSubject(ctx.ports, opts),
      llmCall: ctx.llmCall,
      now: ctx.now,
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    },
  );

  const resultsByArm = new Map<string, BatteryCellResult<HiveScenarioCell, HiveRunHandle, unknown>[]>();
  for (const r of results) {
    const armId = runIdToArm.get(r.runId) ?? r.cell.instanceId;
    (resultsByArm.get(armId) ?? resultsByArm.set(armId, []).get(armId)!).push(r);
  }
  return hiveResultsToExperimentResult(
    armCells.map((a) => ({ armId: a.armId, label: a.label })),
    resultsByArm,
  );
}
