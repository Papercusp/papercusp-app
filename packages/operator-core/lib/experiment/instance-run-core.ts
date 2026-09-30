/**
 * The whole-instance (iq-battery InstanceSubject) live-tier binding
 * (`experiment-registry-invocation-api-2026-06-14` P-063, D-023 — the owner-requested
 * un-staging of the D-022 deferral). Mirrors the gym binding (`gym-run-core.ts`): the
 * PURE transforms (`armToInstanceVariant`, `instanceResultsToExperimentResult`) are
 * fake-testable ($0); the LIVE `BeekeeperDeps` (the real boot + run + judge) is injected
 * via `ctx.deps` and is ABSENT until the owner arms it, so the instance tier stays
 * STAGED (`run()` refuses without it).
 *
 * An arm varies the instance two ways (the `['genome','model']` slice):
 *   - `genome.*` → a genome delta applied with `varyInstanceSpec` → a same-origin variant
 *     spec (the fair Δ-selection, Apiary D-008);
 *   - `model.<role>` → a spawn-time model override carried on the boot spec
 *     (`InstanceBootSpec.modelOverrides`) — the new model-per-role axis (D-003); the live
 *     `runInstance` reads it at spawn (the AGENT_MODELS-style override). It is deliberately
 *     NOT a genome axis, so it never changes the genome content-address / fairness key.
 *
 * `runBeekeeperBattery` is single-instance, so an A/B runs one battery PER ARM (each arm =
 * a config-varied instance over the same corpus) and `compareArms` ranks the per-arm
 * mean composite — the whole-instance analogue of the gym's multi-variant battery.
 */
import { BASELINE_ID, compareArms, type CompareArm, type CompareSelectResult } from '@papercusp/eval-battery';
import {
  runBeekeeperBattery,
  type BeekeeperConfig,
  type BeekeeperDeps,
  type BeekeeperResult,
} from '../iq-battery/beekeeper-runner';
import type { InstanceBootSpec } from '../iq-battery/instance-manifest';
import { instanceBootSpecFromSpec } from '../instance-spec/instance-subject';
import { varyInstanceSpec } from '../instance-spec/vary';
import type { InstanceSpec } from '../instance-spec/types';
import { partitionArm, type KnobArm } from './knob-space';
import type { ExperimentArmResult, ExperimentRunResult } from './types';

/** The instance-specific battery input on the experiment request payload — the base
 *  instance to vary + the corpus + the judge rubric the iq-battery loop already assembles. */
export interface InstanceExperimentPayload {
  /** The champion instance spec; arms apply genome deltas to it (the empty arm IS it). */
  baseSpec: InstanceSpec;
  /** The eval corpus each arm's instance is scored over. */
  corpus: BeekeeperConfig['corpus'];
  /** The frozen judge rubric. */
  rubric: BeekeeperConfig['rubric'];
  /** Where a booted variant is reachable (the live `runInstance` resolves the real URL at
   *  boot; this is the template/placeholder). */
  instanceUrl?: string;
}

/** One arm mapped onto a config-varied instance: the genome-varied boot spec (carrying
 *  any `model.<role>` spawn overrides) + the arm's id for grouping. */
export interface InstanceVariant {
  armId: string;
  label: string;
  bootSpec: InstanceBootSpec;
}

/** Map an arm → a config-varied InstanceBootSpec. `genome.*` folds onto the base spec's
 *  genome (`varyInstanceSpec`); `model.<role>` becomes the boot spec's spawn-time
 *  `modelOverrides`. The empty-knobs arm is the unmodified champion. */
export function armToInstanceVariant(
  base: InstanceSpec,
  arm: KnobArm,
  opts: { workspaceId: string; instanceUrl: string },
): InstanceVariant {
  const { genomeDelta, models } = partitionArm(arm);
  const variedSpec = Object.keys(genomeDelta).length ? varyInstanceSpec(base, genomeDelta) : base;
  // Per-arm instance id so two arms never collide on the same battery rows.
  const bootSpec = instanceBootSpecFromSpec(variedSpec, {
    workspaceId: opts.workspaceId,
    instanceUrl: opts.instanceUrl,
    instanceId: `${arm.id}`,
  });
  return {
    armId: arm.id,
    label: arm.label ?? arm.id,
    bootSpec: Object.keys(models).length ? { ...bootSpec, modelOverrides: models } : bootSpec,
  };
}

/** Sum a battery's per-cell spend (LLM run cost + judge cost). */
function beekeeperCostUsd(r: BeekeeperResult): number {
  return r.outcomes.reduce((s, o) => s + o.costUsd + o.judgeUsd, 0);
}

/** Normalize the per-arm beekeeper results → the common ExperimentRunResult (per-arm mean
 *  composite + the compareArms verdict). */
export function instanceResultsToExperimentResult(
  perArm: { variant: InstanceVariant; result: BeekeeperResult }[],
): ExperimentRunResult {
  const arms: ExperimentArmResult[] = perArm.map(({ variant, result }) => {
    const scored = result.outcomes.filter((o) => o.status === undefined || o.status === 'scored');
    return {
      id: variant.armId,
      label: variant.label,
      meanScore: scored.length ? result.meanComposite : null,
      cells: result.outcomes.length,
      scored: scored.length,
      costUsd: beekeeperCostUsd(result),
    };
  });
  const baseline = arms.find((a) => a.id === BASELINE_ID);
  const candidates = arms.filter((a) => a.id !== BASELINE_ID);
  let comparison: Omit<CompareSelectResult, 'scenarioId'> | null = null;
  if (baseline && candidates.length > 0) {
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
  const selected = perArm.find(({ variant }) => variant.armId === scorecardVariantId);
  const scored = selected?.result.outcomes.filter((o) => o.status === undefined || o.status === 'scored') ?? [];
  const meanDimension = (dimension: 'd1' | 'd2' | 'd3'): number | null =>
    scored.length ? scored.reduce((sum, o) => sum + o[dimension], 0) / scored.length : null;
  return {
    testId: 'instance',
    tier: 'live',
    baselineId: BASELINE_ID,
    arms,
    comparison,
    winner: comparison?.selected ?? null,
    totalCostUsd: perArm.reduce((s, { result }) => s + beekeeperCostUsd(result), 0),
    budgetExhausted: false,
    scorecardScores: {
      composite: selected?.result.meanComposite ?? null,
      d1: meanDimension('d1'),
      d2: meanDimension('d2'),
      d3: meanDimension('d3'),
    },
  };
}

export interface InstanceExperimentRequest {
  batteryId: string;
  arms: KnobArm[];
  payload: InstanceExperimentPayload;
  repeats: number;
  maxDistillChars?: number;
}

export interface InstanceRunCoreCtx {
  workspaceId: string;
  /** The live BeekeeperDeps (boot + run + collect + judge). REQUIRED to execute — it spawns
   *  real instances + spends. Absent ⇒ the instance tier stays STAGED. */
  deps?: BeekeeperDeps;
}

export interface InstanceRunCoreDeps {
  runBeekeeperBattery: typeof runBeekeeperBattery;
}
const defaultInstanceDeps: InstanceRunCoreDeps = { runBeekeeperBattery };

export async function instanceRunCore(
  request: InstanceExperimentRequest,
  ctx: InstanceRunCoreCtx,
  deps: InstanceRunCoreDeps = defaultInstanceDeps,
): Promise<ExperimentRunResult> {
  if (!ctx.deps) {
    throw new Error(
      'the instance tier requires ctx.instance.deps (the live iq-battery BeekeeperDeps) — registered + mapped but STAGED until the owner arms it; its apiary loop drives it (experiment-registry-invocation-api P-063 / D-002 / D-017).',
    );
  }
  if (!request.payload?.baseSpec) throw new Error('instance request.payload.baseSpec (InstanceSpec) is required');
  if (!request.payload?.corpus?.length) throw new Error('instance request.payload.corpus (CorpusCase[]) is required');

  const instanceUrl = request.payload.instanceUrl ?? 'pending://boot';
  const variants = request.arms.map((a) => armToInstanceVariant(request.payload.baseSpec, a, { workspaceId: ctx.workspaceId, instanceUrl }));
  // compareArms needs the baseline anchor — prepend the unmodified champion if absent.
  if (!variants.some((v) => v.armId === BASELINE_ID)) {
    variants.unshift(armToInstanceVariant(request.payload.baseSpec, { id: BASELINE_ID, knobs: {} }, { workspaceId: ctx.workspaceId, instanceUrl }));
  }

  const liveDeps = ctx.deps;
  const perArm: { variant: InstanceVariant; result: BeekeeperResult }[] = [];
  for (const variant of variants) {
    const config: BeekeeperConfig = {
      instanceSpec: variant.bootSpec,
      corpus: request.payload.corpus,
      repeats: request.repeats,
      rubric: request.payload.rubric,
      maxDistillChars: request.maxDistillChars ?? 24_000,
    };
    const result = await deps.runBeekeeperBattery(config, liveDeps);
    perArm.push({ variant, result });
  }
  return instanceResultsToExperimentResult(perArm);
}
