/**
 * Bounded A/B evaluation harness (P-014) — the gym as the eval-battery `HarnessSubject`.
 *
 * Reconciliation D-001: there is ONE eval-battery engine (`@papercusp/eval-battery`'s
 * `runBattery`) with a swappable `Subject` port. The gym is the **HarnessSubject** — a
 * cell's `variant` = a prompt overlay, `run` = the real pipeline *inside a fixed harness*
 * (a COMPONENT eval). `runAbEvaluation` builds that subject + the (variant × task ×
 * repeat) cells, hands them to the engine (which owns the run → collect/distill → judge →
 * record loop + the never-abort + rate-pause discipline), then derives the three P-014
 * deliverables from the engine's per-cell results:
 *   1. per-(variant,task) judge-composite VARIANCE → ε/δ/min-repeats (variance.ts, D-013);
 *   2. COST: $/run + per-variant totals (cost.ts, P-027);
 *   3. the A-vs-B COMPARISON (read-api/store compareVariants, P-013).
 *
 * Pure orchestration with injected effects (`AbDeps`): the pipeline run, the
 * collect+distill, the judge LLM call, and the gym-PG store are all injected, so the
 * sequencing + analysis are unit-tested with fakes (zero LLM, no operator, no PG). The
 * REAL execution passes real adapters (createGymRunnerPorts + the real `llmCall`
 * + a real AGENT_CMD); see `ab-runner-real.ts`. Bounded by construction — the caller sizes
 * `variants × tasks × repeats` (D-019 bounded spend).
 */
import { aggregateRepeats, deriveThresholds, type DeriveOpts, type DerivedThresholds } from './variance';
import { meanRunCostUsd, type RunCost } from './cost';
import { runBattery, type BatteryCell, type Subject } from '@papercusp/eval-battery';
import type { GymScore, JudgeLlmCall } from './judge';
import { rubricHash, type GymJudgeRubric } from './judge-scoring';
import type { VariantOverlay } from './variant-overlay';
import type { GymRunParams, VariantComparisonRow } from './store';
import type { RatePauseDeps } from './rate-pause';
import type { GymTaskCorpus } from './task-corpus';
import type { GymOracleSpec } from './gym-runner';
import type { HarnessPipelineSpend } from '../harness-insights/load-spend';

export interface AbVariant {
  variantId: string;
  label: string;
  overlay: VariantOverlay;
}

export interface AbTask {
  taskId: string;
  pool: string;
  repoUrl: string;
  repoCommit: string;
  spec: string;
  intent: string;
  /** Repo summary the judge weighs spec-gaps against. */
  projectContext: string;
  /** Real-corpus oracle metadata, when this task is test-anchored. */
  oracle?: GymOracleSpec;
  /**
   * Which corpus this task belongs to (gym-real-fitness-signal-2026-07-27 P-003).
   * 'synthetic' = a generated stub substrate (proves the MECHANISM only); 'real' =
   * derived from genuinely shipped work with a known outcome. OMITTED ⇒ treated as
   * 'synthetic' everywhere downstream, so an unlabelled task can never inflate a
   * champion's provenance. Read by the `fitness-signal-is-real` release gate.
   */
  corpus?: GymTaskCorpus;
}

export interface AbConfig {
  variants: AbVariant[];
  tasks: AbTask[];
  /** Repeats per (variant × task) — the variance sample (D-013). */
  repeats: number;
  rubric: GymJudgeRubric;
  harnessCommit: string;
  workspaceId: string;
  scratchRoot: string;
  deriveOpts: DeriveOpts;
  maxDistillChars: number;
}

export interface AbRunInput {
  variant: AbVariant;
  task: AbTask;
  repeat: number;
  cycle: number;
  harnessCommit: string;
  workspaceId: string;
  scratchRoot: string;
}

export interface AbRunHandle {
  harnessSlug: string;
  clonePath: string;
  workflowID: string;
  /** terminal_state (observability, D-011). */
  outcome: string;
  /** Cost of the harness pipeline run (its agent spawns). */
  pipelineUsd: number;
  /** Canonical native receipts; omitted by older injected/custom runners. */
  pipelineSpend?: HarnessPipelineSpend;
  /** Deterministic signals measured while running the task's oracle. */
  deterministicSignals?: Record<string, unknown>;
}

export interface AbStore {
  upsertVariant(v: AbVariant): Promise<void>;
  upsertTask(t: AbTask): Promise<void>;
  startRun(r: {
    runId: string;
    variantId: string;
    taskId: string;
    cycle: number;
    repeat: number;
    harnessSlug: string;
    workflowId: string;
    /** Available runner/rubric declarations; omit when unknown. */
    params?: GymRunParams;
  }): Promise<void>;
  finishRun(runId: string, fields: { terminalState: string; deterministicSignals: unknown; traceRef?: string }): Promise<void>;
  recordScore(runId: string, score: GymScore): Promise<void>;
  comparison(variantA: string, variantB: string, rubricHash: string): Promise<VariantComparisonRow[]>;
}

export interface AbDeps {
  store: AbStore;
  runPipeline(input: AbRunInput): Promise<AbRunHandle>;
  collectAndDistill(input: {
    handle: AbRunHandle;
    task: AbTask;
    maxChars: number;
  }): Promise<{ distilledTrace: string; traceRef: string; rawSignals: unknown }>;
  llmCall: JudgeLlmCall;
  newRunId(variantId: string, taskId: string, repeat: number): string;
  now(): number;
  /** RB-006: injected for the rate-limit pause+resume wait (defaults to real setTimeout). */
  sleep?(ms: number): Promise<void>;
  /** await-event P-010: pause/reset visibility hooks (ratePauseEventHooks in
   *  the real adapter; omitted in unit fakes — purity preserved). */
  ratePauseHooks?: Pick<RatePauseDeps, 'onPause' | 'onReset'>;
}

export interface AbRunOutcome {
  variantId: string;
  taskId: string;
  repeat: number;
  runId: string;
  harnessSlug: string;
  outcome: string;
  d1: number;
  d2: number;
  d3: number;
  composite: number;
  pipelineUsd: number;
  pipelineSpend?: HarnessPipelineSpend;
  judgeUsd: number;
  /** False means judgeUsd is only the known lower bound. */
  judgeCostMeasured?: boolean;
  /**
   * RB-006: disposition of this run's EVALUATION. `'scored'` (default/absent) = judged
   * normally; `'rate_limited'` = the judge turn stayed rate-limited past our bounded pause, so
   * the run is recorded (not scored) and the A/B continues instead of aborting; `'errored'` =
   * any other failure in the run/judge. Non-`'scored'` outcomes are EXCLUDED from variance.
   */
  status?: 'scored' | 'rate_limited' | 'errored';
  /** The failure message for a non-`'scored'` outcome (observability). */
  error?: string;
}

export interface PerTaskVariance extends DerivedThresholds {
  variantId: string;
  taskId: string;
  mean: number;
  sd: number;
  n: number;
}

export interface AbResult {
  outcomes: AbRunOutcome[];
  /** Per-(variant,task) judge-composite variance + the derived ε/δ/min-repeats (D-013). */
  perTaskVariance: PerTaskVariance[];
  cost: { totalUsd: number; meanRunUsd: number; perVariant: Record<string, number>; costMeasured?: boolean };
  /** A-vs-B per-task composite + signed delta (variant[0] = A/baseline, variant[1] = B). */
  comparison: VariantComparisonRow[];
  rubricHash: string;
}

export async function runAbEvaluation(config: AbConfig, deps: AbDeps): Promise<AbResult> {
  const rh = rubricHash(config.rubric);

  for (const v of config.variants) await deps.store.upsertVariant(v);
  for (const t of config.tasks) await deps.store.upsertTask(t);

  // The gym IS the eval-battery's HarnessSubject (reconciliation D-001): run the real
  // pipeline inside a fixed harness, distill its trace, and supply the judge's intent /
  // project-context for the cell's task. The engine owns the per-cell run→distill→judge→
  // record loop + the never-abort + rate-pause discipline (RB-006).
  const subject: Subject<AbRunInput, AbRunHandle> = {
    run: (cell) => deps.runPipeline(cell),
    collectAndDistill: ({ handle, cell, maxChars }) => deps.collectAndDistill({ handle, task: cell.task, maxChars }),
    judgeInput: (cell) => ({ intent: cell.task.intent, projectContext: cell.task.projectContext }),
  };

  // One cell per (variant × task × repeat), variant-major (sequential by design: bounded
  // spend + a shared LLM rate limit, so we don't fan out concurrently here).
  const cells: BatteryCell<AbRunInput>[] = [];
  for (const variant of config.variants) {
    for (const task of config.tasks) {
      for (let repeat = 0; repeat < config.repeats; repeat++) {
        cells.push({
          runId: deps.newRunId(variant.variantId, task.taskId, repeat),
          cell: {
            variant,
            task,
            repeat,
            cycle: 0,
            harnessCommit: config.harnessCommit,
            workspaceId: config.workspaceId,
            scratchRoot: config.scratchRoot,
          },
        });
      }
    }
  }

  const results = await runBattery<AbRunInput, AbRunHandle>(
    { cells, rubric: config.rubric, maxDistillChars: config.maxDistillChars, stopOnUnmeasuredJudgeCost: true },
    {
      subject,
      llmCall: deps.llmCall,
      now: deps.now,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.ratePauseHooks ? { ratePauseHooks: deps.ratePauseHooks } : {}),
      hooks: {
        onStart: ({ runId, cell, handle }) =>
          deps.store.startRun({
            runId,
            variantId: cell.variant.variantId,
            taskId: cell.task.taskId,
            cycle: 0,
            repeat: cell.repeat,
            harnessSlug: handle.harnessSlug,
            workflowId: handle.workflowID,
            params: {
              harnessCommit: cell.harnessCommit,
              substrateCommit: cell.task.repoCommit,
              judgeModel: config.rubric.model,
              judgeTemp: config.rubric.temperature,
              weights: config.rubric.weights,
              rubricHash: rh,
            },
          }),
        onFinish: ({ runId, handle, distilled }) =>
          deps.store.finishRun(runId, {
            terminalState: handle.outcome,
            deterministicSignals: distilled.rawSignals,
            traceRef: distilled.traceRef,
          }),
        onScore: ({ runId, score }) => deps.store.recordScore(runId, score),
      },
    },
  );

  // Map the engine's per-cell results → the gym's AbRunOutcome shape. A non-'scored'
  // cell (rate_limited / errored) carries no real composite (zeros) + its error.
  const outcomes: AbRunOutcome[] = results.map((r) => {
    const base = { variantId: r.cell.variant.variantId, taskId: r.cell.task.taskId, repeat: r.cell.repeat, runId: r.runId, judgeCostMeasured: r.judgeCostMeasured,
      ...(r.handle?.pipelineSpend ? { pipelineSpend: r.handle.pipelineSpend } : {}) };
    if (r.status === 'scored' && r.score) {
      return {
        ...base,
        harnessSlug: r.handle!.harnessSlug,
        outcome: r.handle!.outcome,
        d1: r.score.d1,
        d2: r.score.d2,
        d3: r.score.d3,
        composite: r.score.composite,
        pipelineUsd: r.handle!.pipelineUsd,
        judgeUsd: r.judgeCostUsd,
        status: 'scored' as const,
      };
    }
    return {
      ...base,
      harnessSlug: r.handle?.harnessSlug ?? '',
      outcome: r.handle?.outcome ?? r.status,
      d1: 0,
      d2: 0,
      d3: 0,
      composite: 0,
      pipelineUsd: r.handle?.pipelineUsd ?? 0,
      judgeUsd: r.judgeCostUsd,
      status: r.status,
      error: r.error,
    };
  });

  // 1. Per-(variant,task) variance → ε/δ/min-repeats. Non-scored runs (rate_limited/errored)
  //    carry no real composite, so they are EXCLUDED from the variance sample (RB-006).
  const perTaskVariance: PerTaskVariance[] = [];
  for (const variant of config.variants) {
    for (const task of config.tasks) {
      const composites = outcomes
        .filter((o) => o.variantId === variant.variantId && o.taskId === task.taskId && (o.status ?? 'scored') === 'scored')
        .map((o) => o.composite);
      if (composites.length === 0) continue;
      const stats = aggregateRepeats(composites);
      const thr = deriveThresholds(stats.sd, config.deriveOpts);
      perTaskVariance.push({ variantId: variant.variantId, taskId: task.taskId, mean: stats.mean, sd: stats.sd, n: stats.n, ...thr });
    }
  }

  // 2. Cost.
  const runCosts: RunCost[] = outcomes.map((o) => ({ pipelineUsd: o.pipelineUsd, judgeUsd: o.judgeUsd }));
  const totalUsd = runCosts.reduce((s, c) => s + c.pipelineUsd + c.judgeUsd, 0);
  const perVariant: Record<string, number> = {};
  for (const o of outcomes) perVariant[o.variantId] = (perVariant[o.variantId] ?? 0) + o.pipelineUsd + o.judgeUsd;

  // 3. A-vs-B comparison (variant[0] = A/baseline, variant[1] = B/candidate when present).
  const a = config.variants[0]?.variantId;
  const b = config.variants[1]?.variantId ?? a;
  const costMeasured = results.every((r) => r.judgeCostMeasured && r.handle?.pipelineSpend?.measured !== false);
  const comparison = a && costMeasured ? await deps.store.comparison(a, b, rh) : [];

  return {
    outcomes,
    perTaskVariance,
    cost: { totalUsd, meanRunUsd: meanRunCostUsd(runCosts), perVariant, costMeasured },
    comparison,
    rubricHash: rh,
  };
}
