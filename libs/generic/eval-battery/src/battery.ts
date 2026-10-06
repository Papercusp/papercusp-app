/**
 * The one eval-battery engine (`runBattery`) — reconciliation D-001.
 *
 * The shared per-cell discipline, factored out of the gym's `runAbEvaluation` and the
 * apiary's `runBeekeeperBattery` (which were two near-identical loops): for each
 * (variant × case × repeat) cell, sequentially —
 *   run the subject → collect + distill the trace → [optional metrics] →
 *   judge it with the frozen LLM judge (wrapped in the rate-pause) → record the score.
 * Sequential by design (bounded spend + a shared LLM rate limit). Each cell is wrapped
 * so a single failure (a rate-limited judge past the bounded pause, a run error) is
 * RECORDED and the battery CONTINUES — never aborting the remaining cells.
 *
 * The engine is subject-agnostic: it iterates `cells`, delegates run/distill/judgeInput
 * to the injected {@link Subject}, and calls caller-bound lifecycle hooks (the store
 * writes + optional metric collection) at the same points the two legacy runners did.
 * It returns the raw per-cell results; the caller maps them to its own outcome shape and
 * does its own aggregation (the gym's variance/cost/comparison, the apiary's
 * passed/meanComposite) — that part is genuinely subject-specific and stays caller-side.
 */
import { rateLimitInfo } from '@papercusp/testing-shell/llm';
import { judgeBatteryRun, JUDGE_SOURCE_HASHES, type BatteryScore, type JudgeLlmCall } from './judge';
import type { BatteryRubric } from './scoring';
import { runWithRatePause, RATE_PAUSE_SOURCE_HASH, type RatePauseDeps } from './rate-pause';
import type { DistilledRun, Subject } from './subject';
import { captureSourceHash } from './source-identity';

/** Measured local engine modules; transport and external classifiers are
 * deliberately outside this manifest, so this is not a complete code pin. */
export const EVAL_BATTERY_SOURCE_HASHES = Object.freeze({
  engine: captureSourceHash(import.meta.url), ...JUDGE_SOURCE_HASHES, ratePause: RATE_PAUSE_SOURCE_HASH,
});

/** One cell the engine will run: a (variant, case, repeat) with a stable run id. */
export interface BatteryCell<TCell> {
  /** The store's run id for this cell. */
  runId: string;
  /** The subject's run-input payload (carries the variant + case + repeat). */
  cell: TCell;
}

/** Lifecycle hooks bound to the caller's store, called at the same points the two
 *  legacy runners called theirs — so storage + metrics behavior is preserved exactly. */
export interface BatteryHooks<TCell, THandle, TSignals, TMetrics> {
  /** After the subject's run returns, before collect (legacy: `store.startRun`). */
  onStart?(ctx: { runId: string; cell: TCell; handle: THandle }): Promise<void> | void;
  /** After collect + distill (legacy: `store.finishRun`). */
  onFinish?(ctx: {
    runId: string;
    cell: TCell;
    handle: THandle;
    distilled: DistilledRun<TSignals>;
    elapsedMs: number;
  }): Promise<void> | void;
  /** Optional metric collection from the distilled run's signals (legacy: the apiary's
   *  `collectMetrics`; the gym omits it). Returns the metrics threaded into `onScore`. */
  collectMetrics?(ctx: { runId: string; cell: TCell; distilled: DistilledRun<TSignals> }): Promise<TMetrics>;
  /** After the judge scores (legacy: `store.recordScore`). */
  onScore?(ctx: { runId: string; cell: TCell; score: BatteryScore; metrics?: TMetrics }): Promise<void> | void;
}

/** The disposition of one cell's EVALUATION. `scored` = judged normally; `rate_limited`
 *  = the judge stayed limited past the bounded pause (recorded, not scored); `errored` =
 *  any other failure. Non-`scored` are recorded + excluded from aggregation, never abort. */
export type BatteryCellStatus = 'scored' | 'rate_limited' | 'errored';

/** The per-cell result the engine returns; the caller maps it to its outcome shape. */
export interface BatteryCellResult<TCell, THandle, TMetrics> {
  runId: string;
  cell: TCell;
  handle?: THandle;
  score?: BatteryScore;
  metrics?: TMetrics;
  status: BatteryCellStatus;
  error?: string;
  elapsedMs: number;
  /** Known judge charges across repairs and rate-pause retries, including failed cells. */
  judgeCostUsd: number;
  /** False when a call failed without a measured charge; the dollar total is then a lower bound. */
  judgeCostMeasured: boolean;
}

export interface RunBatteryConfig<TCell> {
  /** The cells to run, in order (the caller expands variant×case×repeat). */
  cells: BatteryCell<TCell>[];
  /** The frozen judge rubric for this battery. */
  rubric: BatteryRubric;
  /** Distilled-trace cap handed to the subject's `collectAndDistill`. */
  maxDistillChars: number;
  /** Governed callers stop new judge attempts/cells if a charge cannot be measured. */
  stopOnUnmeasuredJudgeCost?: boolean;
}

export interface RunBatteryDeps<TCell, THandle, TSignals, TMetrics> {
  subject: Subject<TCell, THandle, TSignals>;
  llmCall: JudgeLlmCall;
  hooks?: BatteryHooks<TCell, THandle, TSignals, TMetrics>;
  now(): number;
  /** Injected for the rate-pause wait (defaults to real setTimeout). */
  sleep?(ms: number): Promise<void>;
  /** Pause/reset visibility hooks for the rate-pause (await-event-primitive). */
  ratePauseHooks?: Pick<RatePauseDeps, 'onPause' | 'onReset'>;
  /** Classify a thrown error as rate-limited (→ `rate_limited`, else `errored`).
   *  Defaults to the typed `rateLimitInfo` classifier — a subject can inject its own. */
  classifyRateLimited?(err: unknown): boolean;
}

export async function runBattery<TCell, THandle, TSignals = unknown, TMetrics = unknown>(
  config: RunBatteryConfig<TCell>,
  deps: RunBatteryDeps<TCell, THandle, TSignals, TMetrics>,
): Promise<BatteryCellResult<TCell, THandle, TMetrics>[]> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isRateLimited = deps.classifyRateLimited ?? ((e: unknown) => rateLimitInfo(e) != null);
  const results: BatteryCellResult<TCell, THandle, TMetrics>[] = [];

  for (const { runId, cell } of config.cells) {
    const started = deps.now();
    let handle: THandle | undefined;
    let judgeCostUsd = 0;
    let judgeCostMeasured = true;
    const recordCharge = (cost: unknown) => {
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) judgeCostUsd += cost;
      else judgeCostMeasured = false;
    };
    const measuredJudge: JudgeLlmCall = async (opts) => {
      if (config.stopOnUnmeasuredJudgeCost && !judgeCostMeasured) {
        throw new Error('judge spend is unmeasured — further judge attempts refused');
      }
      let reply;
      try {
        reply = await deps.llmCall(opts);
      } catch (error) {
        recordCharge((error as { costUsd?: unknown } | null)?.costUsd);
        throw error;
      }
      recordCharge(reply.costUsd);
      return reply;
    };
    try {
      handle = await deps.subject.run(cell);
      await deps.hooks?.onStart?.({ runId, cell, handle });

      const distilled = await deps.subject.collectAndDistill({ handle, cell, maxChars: config.maxDistillChars });
      const elapsedMs = Math.max(0, deps.now() - started);
      await deps.hooks?.onFinish?.({ runId, cell, handle, distilled, elapsedMs });

      const metrics = deps.hooks?.collectMetrics
        ? await deps.hooks.collectMetrics({ runId, cell, distilled })
        : undefined;

      const { intent, projectContext } = deps.subject.judgeInput(cell);
      const score = await runWithRatePause(
        () =>
          judgeBatteryRun(
            { intent, projectContext, distilledTrace: distilled.distilledTrace, rubric: config.rubric },
            { llmCall: measuredJudge },
          ),
        { now: deps.now, sleep, ...(deps.ratePauseHooks ?? {}) },
      );
      // A rate-pause can restart judgement after an earlier paid reply. Its
      // successful score alone accounts only for the final judgement attempt.
      score.costUsd = judgeCostUsd;
      if (config.stopOnUnmeasuredJudgeCost && !judgeCostMeasured) {
        throw new Error('judge spend is unmeasured — scoring and further cells refused');
      }
      await deps.hooks?.onScore?.({ runId, cell, score, metrics });

      results.push({ runId, cell, handle, score, metrics, status: 'scored', elapsedMs, judgeCostUsd, judgeCostMeasured });
    } catch (err) {
      // Never abort the battery on one cell. A rate-limited turn (past the bounded pause)
      // → 'rate_limited'; anything else → 'errored'. Recorded + excluded from aggregation.
      const status: BatteryCellStatus = isRateLimited(err) ? 'rate_limited' : 'errored';
      const message = err instanceof Error ? err.message : String(err);
      results.push({ runId, cell, handle, status, error: message, elapsedMs: Math.max(0, deps.now() - started), judgeCostUsd, judgeCostMeasured });
    }
    if (config.stopOnUnmeasuredJudgeCost && !judgeCostMeasured) break;
  }
  return results;
}
