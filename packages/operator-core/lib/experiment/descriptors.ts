/**
 * The experiment descriptors (`experiment-registry-invocation-api` P-011) — the four
 * existing eval-battery Subjects registered as discoverable {@link TestDescriptor}s
 * over the ONE engine. The descriptor's `run` DELEGATES to the Subject's existing
 * runner (no Subject is reconstructed — D-001/audit D-008).
 *
 * v1 fully wires the OFFLINE tier (replay — ~$0, deterministic, the default front
 * door per D-004). The three live-spend tiers (gym component / iq-battery
 * whole-instance / hive-eval whole-hive) are registered with COMPLETE catalog
 * metadata but their `run` is staged: it refuses until the live runner + deps are
 * bound (the P-011 follow-on), matching the staged-arming discipline — discoverable,
 * not yet executable.
 */
import { BASELINE_ID, registerTest, type TestDescriptor } from '@papercusp/eval-battery';
import {
  DEFAULT_REPLAY_RUBRIC,
  REPLAY_BASELINE_VARIANT,
  runReplayBattery,
  type ReplayBatteryResult,
} from '../replay/battery';
import type { ReplayCase, ReplayVariant } from '../replay/types';
import { partitionArm, validateArm, type KnobArm } from './knob-space';
import type { GymExperimentPayload } from './gym-run-core';
import type { InstanceExperimentPayload } from './instance-run-core';
import type { HiveExperimentPayload } from './hive-run-core';
import type { ExperimentRequest, ExperimentRunCtx, ExperimentRunResult } from './types';

/** Injectable seam — the runners the descriptors delegate to (real by default; a
 *  test passes fakes so descriptor mapping is unit-tested with no LLM/PG). */
export interface ExperimentDescriptorDeps {
  runReplayBattery: typeof runReplayBattery;
}
const defaultDeps: ExperimentDescriptorDeps = { runReplayBattery };

type ExperimentDescriptor = TestDescriptor<ExperimentRequest, ExperimentRunResult, ExperimentRunCtx>;

// --------------------------------------------------------------------------
// replay (offline, fully wired) — varies the resumed agent's policy/system prompt
// --------------------------------------------------------------------------

/** Replay can vary the agent's system prompt/policy + the continuation MODEL (P-063). */
const REPLAY_KNOB_SLICE = ['overlay.systemOverlay', 'overlay.systemReplace', 'model'] as const;

interface ReplayPayload {
  cases: ReplayCase[];
}

/** Map an arm → a ReplayVariant. The empty-knobs arm IS the historical baseline.
 *  Exported for the experiment:run path (run-core), which routes the same mapping
 *  through the governed replay substrate. */
export function armToReplayVariant(arm: KnobArm): ReplayVariant {
  if (Object.keys(arm.knobs).length === 0) return REPLAY_BASELINE_VARIANT;
  const { overlay, models } = partitionArm(arm);
  const policy: ReplayVariant['policy'] = {};
  if (typeof overlay.systemReplace === 'string') policy.systemReplace = overlay.systemReplace;
  if (typeof overlay.systemOverlay === 'string') policy.systemOverlay = overlay.systemOverlay;
  // Replay has one agent, so the first model.<role> knob sets the continuation model.
  const model = Object.values(models)[0];
  if (typeof model === 'string') policy.model = model;
  return { variantId: arm.id, label: arm.label ?? arm.id, policy };
}

/** Normalize a ReplayBatteryResult → the common ExperimentRunResult. Exported for
 *  the experiment:run path (run-core). */
export function replayResultToExperimentResult(r: ReplayBatteryResult): ExperimentRunResult {
  const scorecardVariantId = r.comparison?.selected ?? BASELINE_ID;
  const meanDimension = (dimension: 'd1' | 'd2' | 'd3'): number | null => {
    const scored = r.outcomes.filter((o) => o.status === 'scored' && o.variantId === scorecardVariantId);
    return scored.length ? scored.reduce((sum, o) => sum + o[dimension], 0) / scored.length : null;
  };
  return {
    testId: 'replay',
    tier: 'offline',
    baselineId: BASELINE_ID,
    arms: r.perVariant.map((v) => ({
      id: v.variantId,
      label: v.label,
      meanScore: v.meanComposite,
      cells: v.cells,
      scored: v.scored,
      costUsd: v.costUsd,
    })),
    comparison: r.comparison,
    winner: r.comparison?.selected ?? null,
    totalCostUsd: r.totalCostUsd,
    budgetExhausted: r.budgetExhausted,
    scorecardScores: {
      d1: meanDimension('d1'),
      d2: meanDimension('d2'),
      d3: meanDimension('d3'),
    },
  };
}

export function replayDescriptor(deps: ExperimentDescriptorDeps = defaultDeps): ExperimentDescriptor {
  return {
    id: 'replay',
    summary:
      'Counterfactual replay — re-run a historical/synthetic transcript point under a varied agent policy or model and score the divergence vs what actually happened. ~$0, deterministic baseline; the default offline tier (D-004).',
    kind: 'replay',
    fidelityTier: 'offline',
    costClass: 'free',
    knobSlice: [...REPLAY_KNOB_SLICE],
    metrics: {
      signals: ['divergence.tokenJaccard'],
      rubricDimensions: Object.keys(DEFAULT_REPLAY_RUBRIC.dimensions),
      rubricRef: 'experiment-replay-quality',
    },
    async run(request, ctx) {
      if (!ctx.replayRunner) throw new Error('replay descriptor requires ctx.replayRunner (the offline runner)');
      for (const arm of request.arms) {
        const v = validateArm(arm, REPLAY_KNOB_SLICE);
        if (!v.ok) {
          const bad = [...v.outOfSlice, ...v.excluded.map((e) => `${e} (safety-excluded)`)].join(', ');
          throw new Error(`replay arm "${arm.id}" has knobs outside its slice: ${bad}`);
        }
      }
      const payload = request.payload as ReplayPayload | undefined;
      if (!payload?.cases?.length) throw new Error('replay request.payload.cases is required');

      const result = await deps.runReplayBattery(
        {
          batteryId: request.batteryId,
          variants: request.arms.map(armToReplayVariant),
          cases: payload.cases,
          repeats: request.repeats,
          ...(request.maxDistillChars !== undefined ? { maxDistillChars: request.maxDistillChars } : {}),
          ...(request.budgetUsd !== undefined ? { maxSpendUsd: request.budgetUsd } : {}),
        },
        {
          runner: ctx.replayRunner,
          llmCall: ctx.llmCall,
          now: ctx.now,
          ...(ctx.store?.replay ? { store: ctx.store.replay } : {}),
          ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
        },
      );
      return replayResultToExperimentResult(result);
    },
  };
}

// --------------------------------------------------------------------------
// the live-spend tiers — registered + discoverable, run staged until bound
// --------------------------------------------------------------------------

/**
 * The whole-instance / whole-Hive tiers (the gated cost-exception, D-002) — now BOUND to
 * their live runners (P-063/D-023, the owner-requested un-staging of the D-022 deferral),
 * mirroring the gym binding. The run validates each arm against the test's
 * `['genome','model']` slice + the safety set (P-021), then DELEGATES to the tier's
 * run-core (`instance-run-core` / `hive-run-core`), which maps each arm onto a
 * config-varied instance (a `genome.*` delta + the `model.<role>` spawn override) and runs
 * it via the injected live deps. Those live deps (iq-battery `BeekeeperDeps` / hive-eval
 * `HiveRunPorts`) are heavy infra experiment:run does not provision and the apiary/hive-eval
 * loops already drive — so absent the injected deps the run-core refuses with NO spend
 * (still "discoverable-but-staged" until the owner arms it). These tiers stay the gated
 * cost-exception reached only via the escalation discipline (P-041), never the default.
 */
function liveGenomeModelDescriptor(
  meta: Omit<ExperimentDescriptor, 'run'> & { fidelityTier: 'live' },
  delegate: (request: ExperimentRequest, ctx: ExperimentRunCtx) => Promise<ExperimentRunResult>,
): ExperimentDescriptor {
  return {
    ...meta,
    async run(request, ctx) {
      for (const arm of request.arms) {
        const v = validateArm(arm, meta.knobSlice);
        if (!v.ok) {
          const bad = [...v.outOfSlice, ...v.excluded.map((e) => `${e} (safety-excluded)`)].join(', ');
          throw new Error(`${meta.id} arm "${arm.id}" has knobs outside its slice: ${bad}`);
        }
      }
      return delegate(request, ctx);
    },
  };
}

export function gymDescriptor(): ExperimentDescriptor {
  const knobSlice = ['overlay', 'model'];
  return {
    id: 'gym',
    summary:
      'Component eval — run the real coding pipeline inside a fixed harness under a per-role prompt overlay (`overlay.<role>`) / model swap (`model.<role>`) and judge the diff (the gym HarnessSubject). Live agent spend; mapped + wired but STAGED until the owner arms the gym AbDeps (P-063).',
    kind: 'component',
    fidelityTier: 'live',
    costClass: 'high',
    knobSlice,
    metrics: {
      signals: ['regressionsFromTests', 'plantedBugCaught', 'cost'],
      rubricDimensions: ['d1', 'd2', 'd3'],
      rubricRef: 'experiment-component-quality',
    },
    async run(request, ctx) {
      for (const arm of request.arms) {
        const v = validateArm(arm, knobSlice);
        if (!v.ok) {
          const bad = [...v.outOfSlice, ...v.excluded.map((e) => `${e} (safety-excluded)`)].join(', ');
          throw new Error(`gym arm "${arm.id}" has knobs outside its slice: ${bad}`);
        }
      }
      const { gymRunCore } = await import('./gym-run-core');
      return gymRunCore(
        {
          batteryId: request.batteryId,
          arms: request.arms,
          payload: request.payload as GymExperimentPayload,
          repeats: request.repeats,
          ...(request.maxDistillChars !== undefined ? { maxDistillChars: request.maxDistillChars } : {}),
        },
        { workspaceId: ctx.workspaceId, ...(ctx.gym?.abDeps ? { abDeps: ctx.gym.abDeps } : {}) },
      );
    },
  };
}

export function instanceDescriptor(): ExperimentDescriptor {
  return liveGenomeModelDescriptor(
    {
      id: 'instance',
      summary:
        'Whole-instance eval — boot a config-varied instance from a genome delta + model.<role> spawn override (the iq-battery InstanceSubject) and score it. The gated cost-exception, used when a component eval cannot isolate the variable (D-002); live when ctx.instance.deps are armed.',
      kind: 'whole-instance',
      fidelityTier: 'live',
      costClass: 'high',
      knobSlice: ['genome', 'model'],
      metrics: {
        signals: ['status', 'tokens', 'escalation'],
        rubricDimensions: ['composite'],
        rubricRef: 'experiment-instance-quality',
      },
    },
    async (request, ctx) => {
      const { instanceRunCore } = await import('./instance-run-core');
      return instanceRunCore(
        {
          batteryId: request.batteryId,
          arms: request.arms,
          payload: request.payload as InstanceExperimentPayload,
          repeats: request.repeats,
          ...(request.maxDistillChars !== undefined ? { maxDistillChars: request.maxDistillChars } : {}),
        },
        { workspaceId: ctx.workspaceId, ...(ctx.instance?.deps ? { deps: ctx.instance.deps } : {}) },
      );
    },
  );
}

export function hiveDescriptor(): ExperimentDescriptor {
  return liveGenomeModelDescriptor(
    {
      id: 'hive',
      summary:
        'Whole-hive eval — run a seeded Hive scenario end-to-end under a genome + model.<role> varied instance (the hive-eval Subject) and score outcome × efficiency × speed. Live agent spend; live when ctx.hive.ports are armed.',
      kind: 'whole-hive',
      fidelityTier: 'live',
      costClass: 'high',
      knobSlice: ['genome', 'model'],
      metrics: {
        signals: ['outcome', 'efficiency', 'speed'],
        rubricDimensions: ['outcome', 'efficiency', 'speed'],
        rubricRef: 'experiment-hive-quality',
      },
    },
    async (request, ctx) => {
      const { hiveRunCore } = await import('./hive-run-core');
      return hiveRunCore(
        {
          batteryId: request.batteryId,
          arms: request.arms,
          payload: request.payload as HiveExperimentPayload,
          repeats: request.repeats,
          ...(request.maxDistillChars !== undefined ? { maxDistillChars: request.maxDistillChars } : {}),
        },
        {
          workspaceId: ctx.workspaceId,
          now: ctx.now,
          llmCall: ctx.llmCall,
          ...(ctx.hive?.ports ? { ports: ctx.hive.ports } : {}),
          ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
        },
      );
    },
  );
}

// --------------------------------------------------------------------------
// registration
// --------------------------------------------------------------------------

let registered = false;

/** Register the four descriptors into the eval-battery default registry. Idempotent
 *  (the host calls it at boot; the catalog/run tools call it lazily). */
export function registerExperimentDescriptors(deps: ExperimentDescriptorDeps = defaultDeps): void {
  if (registered) return;
  registerTest(replayDescriptor(deps));
  registerTest(gymDescriptor());
  registerTest(instanceDescriptor());
  registerTest(hiveDescriptor());
  registered = true;
}

/** Test seam — reset the idempotency latch (pair with `resetTestRegistry`). */
export function _resetExperimentRegistration(): void {
  registered = false;
}
