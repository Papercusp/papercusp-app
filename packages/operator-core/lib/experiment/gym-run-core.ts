/**
 * The gym live-tier binding (experiment-registry-invocation-api-2026-06-14 #3) — maps
 * an experiment request onto the gym's `AbConfig` and delegates to `runAbEvaluation`
 * (the HarnessSubject). The pure transforms (`armToAbVariant`,
 * `abResultToExperimentResult`) are fake-testable ($0); the LIVE `AbDeps`
 * (`createGymRunnerPorts` / `buildAbDeps` — which spawns the real coding pipeline and
 * spends) is injected via `ctx.abDeps` and is ABSENT until the owner arms it, so the gym
 * tier stays STAGED (`run()` refuses without it). The gym-specific run config (repo
 * tasks, deriveOpts, …) rides the request payload — the gym director already assembles
 * it — so this binding hardcodes none of it. instance/hive remain staged-metadata (the
 * heavier gated cost-exception, D-002).
 */
import { BASELINE_ID, compareArms, type CompareArm, type CompareSelectResult } from '@papercusp/eval-battery';
import { runAbEvaluation, type AbConfig, type AbDeps, type AbResult, type AbTask, type AbVariant } from '../gym/ab-runner';
import { GYM_JUDGE_RUBRIC_V1, type GymJudgeRubric } from '../gym/judge-scoring';
import type { VariantOverlay } from '../gym/variant-overlay';
import type { DeriveOpts } from '../gym/variance';
import { partitionArm, type KnobArm } from './knob-space';
import type { ExperimentArmResult, ExperimentRunResult } from './types';

/** The gym-specific battery input on the experiment request payload — the real repo
 *  tasks + the gym run config the gym director already assembles. */
export interface GymExperimentPayload {
  tasks: AbTask[];
  deriveOpts: DeriveOpts;
  harnessCommit?: string;
  scratchRoot?: string;
  rubric?: GymJudgeRubric;
}

/** Map an arm → a gym AbVariant. `overlay.<role>` → promptOverrides[role];
 *  `model.<role>` → models[role]. An empty-knobs arm is the no-overlay baseline. */
export function armToAbVariant(arm: KnobArm): AbVariant {
  const { overlay, models } = partitionArm(arm);
  const promptOverrides: Record<string, string> = {};
  for (const [role, v] of Object.entries(overlay)) if (typeof v === 'string') promptOverrides[role] = v;
  const ov: VariantOverlay = { promptOverrides, ...(Object.keys(models).length ? { models } : {}) };
  return { variantId: arm.id, label: arm.label ?? arm.id, overlay: ov };
}

/** Normalize a gym AbResult → the common ExperimentRunResult (per-variant mean composite
 *  + the compareArms verdict). */
export function abResultToExperimentResult(r: AbResult, variants: AbVariant[]): ExperimentRunResult {
  const costMeasured = r.cost.costMeasured !== false;
  const arms: ExperimentArmResult[] = variants.map((v) => {
    const mine = r.outcomes.filter((o) => o.variantId === v.variantId);
    const scored = mine.filter((o) => o.status === undefined || o.status === 'scored');
    const meanScore = scored.length ? scored.reduce((s, o) => s + o.composite, 0) / scored.length : null;
    return { id: v.variantId, label: v.label, meanScore, cells: mine.length, scored: scored.length, costUsd: r.cost.perVariant[v.variantId] ?? 0, costMeasured: mine.every((o) => o.judgeCostMeasured !== false) };
  });
  const baseline = arms.find((a) => a.id === BASELINE_ID);
  const candidates = arms.filter((a) => a.id !== BASELINE_ID);
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
  const meanDimension = (dimension: 'd1' | 'd2' | 'd3'): number | null => {
    const scored = r.outcomes.filter(
      (o) => (o.status === undefined || o.status === 'scored') && o.variantId === scorecardVariantId,
    );
    return scored.length ? scored.reduce((sum, o) => sum + o[dimension], 0) / scored.length : null;
  };
  return {
    testId: 'gym',
    tier: 'live',
    baselineId: BASELINE_ID,
    arms,
    comparison,
    winner: comparison?.selected ?? null,
    totalCostUsd: r.cost.totalUsd,
    costMeasured,
    budgetExhausted: false,
    scorecardScores: {
      d1: costMeasured ? meanDimension('d1') : null,
      d2: costMeasured ? meanDimension('d2') : null,
      d3: costMeasured ? meanDimension('d3') : null,
    },
  };
}

export interface GymExperimentRequest {
  batteryId: string;
  arms: KnobArm[];
  payload: GymExperimentPayload;
  repeats: number;
  maxDistillChars?: number;
}

export interface GymRunCoreCtx {
  workspaceId: string;
  /** The live AbDeps (createGymRunnerPorts/buildAbDeps). REQUIRED to execute — it spawns
   *  the real pipeline + spends. Absent ⇒ the gym tier stays STAGED. */
  abDeps?: AbDeps;
}

export interface GymRunCoreDeps {
  runAbEvaluation: typeof runAbEvaluation;
}
const defaultGymDeps: GymRunCoreDeps = { runAbEvaluation };

export async function gymRunCore(
  request: GymExperimentRequest,
  ctx: GymRunCoreCtx,
  deps: GymRunCoreDeps = defaultGymDeps,
): Promise<ExperimentRunResult> {
  if (!ctx.abDeps) {
    throw new Error(
      'the gym tier requires ctx.abDeps (the live createGymRunnerPorts AbDeps) — registered + mapped but STAGED until the owner arms it (experiment-registry-invocation-api P-063).',
    );
  }
  if (!request.payload?.tasks?.length) throw new Error('gym request.payload.tasks (AbTask[]) is required');

  const variants = request.arms.map(armToAbVariant);
  // compareArms needs the baseline anchor — prepend the no-overlay baseline if absent.
  if (!variants.some((v) => v.variantId === BASELINE_ID)) {
    variants.unshift({ variantId: BASELINE_ID, label: 'baseline', overlay: { promptOverrides: {} } });
  }

  const config: AbConfig = {
    variants,
    tasks: request.payload.tasks,
    repeats: request.repeats,
    rubric: request.payload.rubric ?? GYM_JUDGE_RUBRIC_V1,
    harnessCommit: request.payload.harnessCommit ?? 'HEAD',
    workspaceId: ctx.workspaceId,
    scratchRoot: request.payload.scratchRoot ?? '/tmp/gym-experiment',
    deriveOpts: request.payload.deriveOpts,
    maxDistillChars: request.maxDistillChars ?? 24_000,
  };

  const result = await deps.runAbEvaluation(config, ctx.abDeps);
  return abResultToExperimentResult(result, variants);
}
