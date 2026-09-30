/**
 * Beekeeper runner v1 (P-003): orchestrate ONE battery execution against ONE papercusp instance.
 *
 * Adapts the gym's ab-runner pattern for instance-level evaluation:
 * - Boot is swapped: GymOperatorBootSpec → InstanceManifest
 * - Store: variants/tasks/runs/scores adapted to beekeeper schema (harness_shared)
 * - Judge + circuit-breaker reused from gym
 * - One instance, battery corpus (P-001), collected metrics (P-002)
 *
 * Runs sequentially (bounded by construction — the caller sizes corpus × repeats).
 * All effects injected for testability (EI-58: testability-seam pattern).
 *
 * Testability seams (EI-58):
 * - BeekeeperDeps interface: all external effects injected (store, instance runner,
 *   metric collection, LLM judge) so unit tests can stub them with mocks/vitest.
 * - RunBeekeeperBattery is pure orchestration: zero implicit dependencies.
 * - Unit tests mock all deps; integration tests stub them for e2e validation.
 */

import { type GymScore, type JudgeLlmCall } from '../gym/judge';
import { rubricHash, type GymJudgeRubric } from '../gym/judge-scoring';
import type { CorpusCase } from './corpus';
import type { IQBatteryMetrics, MetricCollectorInput } from './collectors';
import type { InstanceBootSpec, InstanceRunHandle } from './instance-manifest';
import { runBattery, type BatteryCell, type Subject } from '@papercusp/eval-battery';
import type { RatePauseDeps } from '../gym/rate-pause';

export interface BeekeeperConfig {
  instanceSpec: InstanceBootSpec;
  corpus: CorpusCase[];
  /** Repeats per case — for noise calibration (D-012). */
  repeats: number;
  rubric: GymJudgeRubric;
  maxDistillChars: number;
}

export interface BeekeeperRunInput {
  case: CorpusCase;
  repeat: number;
  instanceSpec: InstanceBootSpec;
}

export interface BeekeeperStore {
  upsertInstance(m: InstanceBootSpec['manifest']): Promise<void>;
  upsertCorpusCase(c: CorpusCase): Promise<void>;
  startRun(r: {
    runId: string;
    instanceId: string;
    caseId: string;
    caseVariant: string;
    caseTitle: string;
  }): Promise<void>;
  finishRun(
    runId: string,
    fields: { terminalState: string; deterministicSignals: unknown; traceRef?: string; elapsedMs: number }
  ): Promise<void>;
  recordScore(runId: string, score: GymScore, metrics: IQBatteryMetrics): Promise<void>;
}

export interface BeekeeperDeps {
  store: BeekeeperStore;
  runInstance(input: BeekeeperRunInput): Promise<InstanceRunHandle>;
  collectAndDistill(input: {
    handle: InstanceRunHandle;
    case: CorpusCase;
    maxChars: number;
  }): Promise<{
    distilledTrace: string;
    traceRef: string;
    rawSignals: unknown;
    /**
     * The run's REAL metric signals (status / tokens / times / escalation /
     * retrieved-vs-expected sources), threaded into `collectMetrics` so the
     * seven collectors measure the actual run — not the stubbed defaults the
     * orchestrator used to pass (apiary-generation-0-battery D-004). Optional:
     * a dep that omits it keeps the prior {runId,caseId,variant}-only behavior.
     */
    signals?: Partial<MetricCollectorInput>;
  }>;
  collectMetrics(input: MetricCollectorInput): Promise<IQBatteryMetrics>;
  llmCall: JudgeLlmCall;
  newRunId(caseId: string, repeat: number): string;
  now(): number;
  sleep?(ms: number): Promise<void>;
  ratePauseHooks?: Pick<RatePauseDeps, 'onPause' | 'onReset'>;
}

export interface BeekeeperRunOutcome {
  caseId: string;
  caseVariant: string;
  repeat: number;
  runId: string;
  instanceId: string;
  outcome: string;
  d1: number;
  d2: number;
  d3: number;
  composite: number;
  costUsd: number;
  judgeUsd: number;
  status?: 'scored' | 'rate_limited' | 'errored';
  error?: string;
}

export interface BeekeeperResult {
  instanceId: string;
  outcomes: BeekeeperRunOutcome[];
  totalCases: number;
  passedCases: number;
  meanComposite: number;
  rubricHash: string;
}

export async function runBeekeeperBattery(config: BeekeeperConfig, deps: BeekeeperDeps): Promise<BeekeeperResult> {
  const rh = rubricHash(config.rubric);

  // Register the instance and corpus cases (setup — stays caller-side, per battery.ts).
  await deps.store.upsertInstance(config.instanceSpec.manifest);
  for (const c of config.corpus) await deps.store.upsertCorpusCase(c);

  const instanceId = config.instanceSpec.manifest.instanceId;

  // The Apiary/gen-0 IS the eval-battery's InstanceSubject (reconciliation D-001 / P-002):
  // run a config-varied whole instance for the cell's case, distill its trace + real metric
  // signals, and supply the judge's intent (the case prompt; projectContext = ''). The shared
  // engine (`runBattery`) now owns the per-cell run → distill → [metrics] → judge → record
  // loop + the never-abort + rate-pause discipline this runner used to implement inline —
  // the SAME loop the gym's HarnessSubject rides (gym/ab-runner.ts). One engine, two subjects.
  const subject: Subject<BeekeeperRunInput, InstanceRunHandle, Partial<MetricCollectorInput>> = {
    run: (cell) => deps.runInstance(cell),
    collectAndDistill: ({ handle, cell, maxChars }) =>
      deps.collectAndDistill({ handle, case: cell.case, maxChars }),
    judgeInput: (cell) => ({ intent: cell.case.prompt, projectContext: '' }),
  };

  // One cell per (case × repeat). Sequential by design (engine-enforced): bounded spend +
  // the shared LLM rate limit on the judge.
  const cells: BatteryCell<BeekeeperRunInput>[] = [];
  for (const caseItem of config.corpus) {
    for (let repeat = 0; repeat < config.repeats; repeat++) {
      cells.push({
        runId: deps.newRunId(caseItem.id, repeat),
        cell: { case: caseItem, repeat, instanceSpec: config.instanceSpec },
      });
    }
  }

  const results = await runBattery<BeekeeperRunInput, InstanceRunHandle, Partial<MetricCollectorInput>, IQBatteryMetrics>(
    { cells, rubric: config.rubric, maxDistillChars: config.maxDistillChars },
    {
      subject,
      llmCall: deps.llmCall,
      now: deps.now,
      // Preserve the beekeeper's existing string-match rate-limit classifier (vs the engine's
      // default typed `rateLimitInfo`) so a rate-limited judge is classified identically.
      classifyRateLimited: isRateLimitError,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.ratePauseHooks ? { ratePauseHooks: deps.ratePauseHooks } : {}),
      hooks: {
        onStart: ({ runId, cell }) =>
          deps.store.startRun({
            runId,
            instanceId,
            caseId: cell.case.id,
            caseVariant: cell.case.variant,
            caseTitle: cell.case.title,
          }),
        onFinish: ({ runId, distilled, elapsedMs }) =>
          deps.store.finishRun(runId, {
            terminalState: 'completed',
            deterministicSignals: distilled.rawSignals,
            traceRef: distilled.traceRef,
            elapsedMs,
          }),
        // Collect metrics from the run's REAL signals (apiary-generation-0-battery D-004):
        // collectAndDistill extracts status/tokens/times/escalation/sources from the actual
        // instance run and returns them as `signals`; thread them into the seven collectors.
        // A dep that omits `signals` (e.g. a test stub) falls back to the
        // {runId,caseId,variant}-only call as before.
        collectMetrics: ({ runId, cell, distilled }) =>
          deps.collectMetrics({
            ...(distilled.signals ?? {}),
            runId,
            caseId: cell.case.id,
            variant: cell.case.variant,
          }),
        // collectMetrics is always provided here, so `metrics` is always defined at onScore.
        onScore: ({ runId, score, metrics }) =>
          deps.store.recordScore(runId, score, metrics as IQBatteryMetrics),
      },
    },
  );

  // Map the engine's per-cell results → the beekeeper's outcome shape. A non-'scored' cell
  // (rate_limited / errored) carries no real composite (zeros) + its error.
  const outcomes: BeekeeperRunOutcome[] = results.map((r) => {
    const base = {
      caseId: r.cell.case.id,
      caseVariant: r.cell.case.variant,
      repeat: r.cell.repeat,
      runId: r.runId,
      instanceId,
    };
    if (r.status === 'scored' && r.score) {
      return {
        ...base,
        outcome: 'completed',
        d1: r.score.d1,
        d2: r.score.d2,
        d3: r.score.d3,
        composite: r.score.composite,
        costUsd: r.handle!.costUsd,
        judgeUsd: r.score.costUsd,
        status: 'scored' as const,
      };
    }
    return {
      ...base,
      outcome: r.handle?.targetSlug ?? '',
      d1: 0,
      d2: 0,
      d3: 0,
      composite: 0,
      costUsd: r.handle?.costUsd ?? 0,
      judgeUsd: 0,
      status: r.status,
      error: r.error,
    };
  });

  const scored = outcomes.filter((o) => o.status === 'scored');
  const passedCases = scored.length;
  // Mean over SCORED outcomes only — when every run errored/rate-limited the
  // divisor is 0 and the old outcomes.length guard still produced 0/0 = NaN.
  const meanComposite =
    scored.length > 0 ? scored.reduce((sum, o) => sum + o.composite, 0) / scored.length : 0;

  return {
    instanceId,
    outcomes,
    totalCases: config.corpus.length * config.repeats,
    passedCases,
    meanComposite,
    rubricHash: rh,
  };
}

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('rate_limit') || err.message.includes('rate-limit');
}
