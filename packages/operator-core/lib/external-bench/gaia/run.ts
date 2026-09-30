/**
 * GAIA run orchestration (plan `benchmark-suite-gaia-2026-06-17`, P-004/P-005). Drives a set of
 * {@link GaiaTask}s through the agent, self-grades each with the quasi-exact-match {@link gradeGaia}, and
 * produces a predictions JSONL `{ task_id, model_answer, reasoning_trace }` + a per-level (L1/L2/L3) +
 * overall accuracy report.
 *
 * The orchestration (bounded concurrency, prediction assembly, infra-error exclusion, grading, aggregation,
 * cost accounting, JSONL emission) is PURE w.r.t. infra — the per-task agent run ({@link GaiaRunDeps.runAgent})
 * is INJECTED, so a fake makes the whole pipeline unit-testable with no LLM/web spend. {@link makeLiveRunAgent}
 * wires the live per-task run (stage attachment → live toolset + LLM → {@link runGaiaAgent} → cleanup).
 */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeGaia, type GaiaLevel, type GaiaPrediction, type GaiaReport } from '../grader/gaia';
import { runGaiaAgent, type GaiaAgentConfig, type GaiaAgentResult, type GaiaAgentStopReason, type LlmFn } from './agent';
import type { GaiaTask } from './dataset';
import { makeLiveGaiaToolset, type LiveToolsConfig } from './tools-live';

/** A predictions-JSONL record (the GAIA convention `{task_id, model_answer, reasoning_trace}` + telemetry). */
export interface GaiaPredictionRecord {
  task_id: string;
  /** The extracted FINAL ANSWER (empty string when the model never emitted one — a formatting failure). */
  model_answer: string;
  /** Compact reasoning trace (the tool-use trajectory) for debugging / publication. */
  reasoning_trace: string;
  level: GaiaLevel;
  stopReason: GaiaAgentStopReason;
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** Present when the run hit an infra error (stopReason==='error'). */
  error?: string;
}

/** Roll-up totals across the run (token + ballpark $ accounting). */
export interface GaiaRunTotals {
  tasks: number;
  tokensIn: number;
  tokensOut: number;
  /** Ballpark $ from {@link OPUS_PRICE} — informational; the canonical cost layer (bench-metrics priceRun) owns the real number. */
  estCostUsd: number;
  wallClockMs: number;
  /** Tasks excluded from accuracy because the agent hit an infra error (stopReason==='error'). */
  infraErrors: number;
  /** Tasks whose prior prediction was reused (RESUME) rather than re-run. */
  reused: number;
}

export interface GaiaRunResult {
  predictions: GaiaPredictionRecord[];
  report: GaiaReport;
  totals: GaiaRunTotals;
}

/** Ballpark opus-4.8 price ($/token) for the informational `estCostUsd` only. */
export const OPUS_PRICE = { inPerTok: 15 / 1_000_000, outPerTok: 75 / 1_000_000 } as const;

export interface GaiaRunDeps {
  /** Run the agent for one task → its result. Injected (fake in tests; {@link makeLiveRunAgent} in prod). */
  runAgent: (task: GaiaTask) => Promise<GaiaAgentResult>;
  now?: () => number;
}

export interface GaiaRunConfig {
  /** Bounded task concurrency (default 4). */
  concurrency?: number;
  /** Exclude infra-error (stopReason==='error') tasks from the scored denominator (default true; SWE-bench discipline). */
  excludeInfraErrors?: boolean;
  /** Max chars of trajectory packed into `reasoning_trace` (default 4000). */
  maxTraceChars?: number;
  /**
   * RESUME: prior predictions (e.g. from a crashed run's predictions.jsonl). A task with a prior record that
   * already produced a real answer (stopReason ≠ 'error' AND model_answer ≠ '') is NOT re-run — its prediction
   * is reused (saving the Opus spend) and re-graded against the gold. Formatting-failure / infra-error tasks
   * ARE re-run (a retry might do better). This makes a long 165-task run crash-resumable.
   */
  priorPredictions?: GaiaPredictionRecord[];
  /**
   * CHECKPOINT: called with each freshly-run task's record AS IT COMPLETES (not for reused ones). A caller
   * appends it to a partial predictions.jsonl so a crash mid-run loses at most the in-flight tasks — pairs with
   * {@link priorPredictions} for crash-safe long runs.
   */
  onRecord?: (record: GaiaPredictionRecord) => void;
}

/** Build the predictions record for one freshly-run task. */
function buildRecord(task: GaiaTask, r: GaiaAgentResult, maxTraceChars: number): GaiaPredictionRecord {
  return {
    task_id: task.taskId,
    model_answer: r.finalAnswer ?? '',
    reasoning_trace: renderTrace(r, maxTraceChars),
    level: task.level,
    stopReason: r.stopReason,
    turns: r.turns,
    toolCalls: r.toolCalls,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    ...(r.error ? { error: r.error } : {}),
  };
}

/** Bounded-concurrency map preserving input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Render an agent trajectory into a compact reasoning trace string. */
export function renderTrace(result: GaiaAgentResult, maxChars: number): string {
  const lines = result.trajectory.map((s) => {
    const tag = s.tool ? `${s.kind}:${s.tool}` : s.kind;
    return `[${s.turn}] ${tag}: ${s.summary}`;
  });
  const joined = lines.join('\n');
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}… [trace truncated]`;
}

/**
 * Run a GAIA task set end-to-end and self-grade. Per-task agent failures (infra errors) degrade to an
 * excluded row (surfaced, not scored as a capability fail) when `excludeInfraErrors` (default). Returns the
 * predictions, the per-level + overall {@link GaiaReport}, and roll-up totals.
 */
export async function runGaiaSuite(
  tasks: GaiaTask[],
  deps: GaiaRunDeps,
  config: GaiaRunConfig = {},
): Promise<GaiaRunResult> {
  const concurrency = config.concurrency ?? 4;
  const excludeInfra = config.excludeInfraErrors ?? true;
  const maxTraceChars = config.maxTraceChars ?? 4000;
  const now = deps.now ?? Date.now;
  const startedAt = now();

  // RESUME: a prior record with a real answer (non-error, non-empty) is reused, not re-run.
  const prior = new Map<string, GaiaPredictionRecord>();
  for (const p of config.priorPredictions ?? []) {
    if (p.stopReason !== 'error' && p.model_answer !== '') prior.set(p.task_id, p);
  }
  const toRun = tasks.filter((t) => !prior.has(t.taskId));
  // Build each fresh task's record AS IT COMPLETES (so onRecord can checkpoint incrementally).
  const built = await mapLimit(toRun, concurrency, async (task) => {
    const r = await deps.runAgent(task);
    const record = buildRecord(task, r, maxTraceChars);
    config.onRecord?.(record);
    return { task, r, record };
  });
  const builtById = new Map(built.map((b) => [b.task.taskId, b]));

  const predictions: GaiaPredictionRecord[] = [];
  const gradeInputs: GaiaPrediction[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let infraErrors = 0;
  let reused = 0;

  for (const task of tasks) {
    const priorRec = prior.get(task.taskId);
    if (priorRec) {
      reused++;
      tokensIn += priorRec.tokensIn;
      tokensOut += priorRec.tokensOut;
      predictions.push(priorRec);
      gradeInputs.push({ taskId: task.taskId, modelAnswer: priorRec.model_answer, gold: task.finalAnswer, level: task.level });
      continue;
    }
    const { r, record } = builtById.get(task.taskId)!;
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
    const isInfra = r.stopReason === 'error';
    if (isInfra) infraErrors++;
    predictions.push(record);
    gradeInputs.push({
      taskId: task.taskId,
      rawOutput: r.rawOutput,
      gold: task.finalAnswer,
      level: task.level,
      ...(isInfra && excludeInfra ? { excludeReason: `infra: ${r.error ?? r.stopReason}` } : {}),
    });
  }

  const report = gradeGaia(gradeInputs);
  const totals: GaiaRunTotals = {
    tasks: tasks.length,
    tokensIn,
    tokensOut,
    estCostUsd: tokensIn * OPUS_PRICE.inPerTok + tokensOut * OPUS_PRICE.outPerTok,
    wallClockMs: now() - startedAt,
    infraErrors,
    reused,
  };
  return { predictions, report, totals };
}

/** Parse a predictions.jsonl body → records (for RESUME). Tolerant of blank lines + malformed rows. */
export function parsePredictionsJsonl(body: string): GaiaPredictionRecord[] {
  const out: GaiaPredictionRecord[] = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as GaiaPredictionRecord);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** Serialize predictions → a JSONL string (one record per line). */
export function predictionsToJsonl(predictions: GaiaPredictionRecord[]): string {
  return predictions.map((p) => JSON.stringify(p)).join('\n') + '\n';
}

/**
 * Serialize predictions → the GAIA leaderboard submission JSONL (P-006). The Gradio Space ingests exactly
 * `{ task_id, model_answer, reasoning_trace }` per line — our internal telemetry fields are dropped. Used for
 * the TEST-set submission; the validation run is self-graded and never submitted. `model_answer` is the
 * extracted FINAL ANSWER (empty string when the agent produced no FINAL ANSWER line).
 */
export function toSubmissionJsonl(predictions: GaiaPredictionRecord[]): string {
  return (
    predictions
      .map((p) => JSON.stringify({ task_id: p.task_id, model_answer: p.model_answer, reasoning_trace: p.reasoning_trace }))
      .join('\n') + '\n'
  );
}

/** A one-line human summary of a run report. */
export function formatGaiaReportLine(result: GaiaRunResult): string {
  const r = result.report;
  const byLevel = r.byLevel.map((b) => `L${b.level} ${(b.accuracy * 100).toFixed(1)}% (${b.resolved}/${b.scored})`).join(' · ');
  return (
    `GAIA: overall ${(r.overallAccuracy * 100).toFixed(1)}% (${r.resolved}/${r.scored}) · ${byLevel} · ` +
    `format-fail ${(r.formatFailRate * 100).toFixed(1)}% · excluded ${r.excluded} · infra-err ${result.totals.infraErrors} · ` +
    `~$${result.totals.estCostUsd.toFixed(2)}`
  );
}

/* -------------------------------------------------------------------------- */
/* Live per-task run wiring                                                     */
/* -------------------------------------------------------------------------- */

export interface LiveRunAgentOptions {
  /** The shared live LLM (one gateway client across all tasks). */
  llm: LlmFn;
  /** Per-task agent config (turns / budget). */
  agentConfig?: GaiaAgentConfig;
  /** Live tools config overrides (Brave key, python bin, timeouts); scratchDir is set per task. */
  toolsConfig?: Omit<LiveToolsConfig, 'scratchDir'>;
  /** Scratch root for per-task working dirs (default OS temp). */
  workRoot?: string;
}

/**
 * Build the live per-task `runAgent`: for each task it makes a scratch dir, STAGES the attachment into it
 * (so `read_file`/`run_python` see it by name), wires the live toolset + image reader, runs the agent loop,
 * and cleans up. A staging/cleanup failure never throws out (the loop already degrades infra errors).
 */
export function makeLiveRunAgent(opts: LiveRunAgentOptions): (task: GaiaTask) => Promise<GaiaAgentResult> {
  return async (task: GaiaTask): Promise<GaiaAgentResult> => {
    const scratch = await mkdtemp(join(opts.workRoot ?? tmpdir(), 'gaia-task-'));
    try {
      if (task.fileName && task.filePath) {
        await cp(task.filePath, join(scratch, task.fileName)).catch(() => {});
      }
      const tools = makeLiveGaiaToolset({ ...(opts.toolsConfig ?? {}), scratchDir: scratch });
      const readImageBase64 = async (fp: string): Promise<string> => (await readFile(fp)).toString('base64');
      return await runGaiaAgent(task, { llm: opts.llm, tools, readImageBase64 }, opts.agentConfig);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  };
}
