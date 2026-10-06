/**
 * precision-monitor.ts — the memory-precision-bench RUN path
 * (relight-self-learning-edges-2026-06-14 P-033).
 *
 * The injection floor is SOLVED (D-007: 0.45 cosine / 0.40 lexical is sweep-
 * optimal, FP@5 ~17% at R@10 ~82%) but was benchmarked ONCE. This monitor
 * replays the frozen gold set against the production HYBRID backend AT THE
 * PRODUCTION PUSH FLOOR on a weekly cadence and records the metrics, so floor
 * DRIFT is visible on the Learning tab instead of silently rotting.
 *
 * Why the floored replay (not the unfloored `runBench`): D-007 notes EI-533's
 * "FP@5 = 100%" is the UNFLOORED number; the production push path is floored to
 * ~17%. To MONITOR production precision we measure the same floor the live
 * injector applies — `runGoldSet(..., { minScore, minLexScore })` with the
 * exported {@link MEMORY_INJECTION_COSINE_FLOOR}/{@link MEMORY_INJECTION_LEX_FLOOR}.
 *
 * Cost: embeddings only (corpus seed + gold queries), NO LLM and NO writes to the
 * live memory store — the bench runs in an isolated `bench_memory` PG schema
 * (created/dropped by `makeBackendCtx('hybrid')`). ~$0.05/run (or free on a local
 * embedder). Flag-only gating (no governor — like change-ledger): the routine is
 * cheap bookkeeping, not a budgeted frontier loop.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { memoryHost, type MemoryCredentials } from '@papercusp/memory';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { collectChildOutput } from '../../child-output';
import { resolveJevMemoryInjection } from '../jev-settings';
import {
  recordMemoryPrecisionAttempt,
  recordMemoryPrecisionRun,
  readMemoryPrecision,
  PRECISION_BENCH_WORKER_TIMEOUT_MS,
  type MemoryPrecisionAttemptInput,
  type MemoryPrecisionAttemptStage,
  type MemoryPrecisionMetrics,
} from './precision-read';
import { evaluateRecallDrop, BASELINE_HISTORY_WINDOW, type PriorRun, type RecallDropEvaluation } from './precision-alert';
import { fileRecallDropEi, resolveRecallDropEi } from './precision-alert-ei';
import { tsxBin } from '../../harness-paths';
import { PRECISION_BENCH_JEV_GATE_ENV, PRECISION_BENCH_RESULT_MARKER } from './precision-bench-core';
import { PRECISION_BENCH_EMBEDDER_MODE_ENV } from './precision-bench-host';

export { PRECISION_BENCH_EMBEDDER_MODE_ENV };

export {
  assertCorpusSeeded,
  benchMemoryPrecision,
  gateReplayWithJev,
  jevGatedShape,
  PRECISION_BENCH_JEV_CONSUMER,
  PRECISION_BENCH_JEV_GATE_ENV,
  PRECISION_BENCH_RESULT_MARKER,
} from './precision-bench-core';
export type { JevGateFn, JevGateReplayStats } from './precision-bench-core';

export interface PrecisionBenchWorkerTarget {
  path: string;
  runtime: 'node' | 'tsx';
}

/**
 * Bundlers relocate this module into a single host entry, so its source-relative
 * `.ts` worker URL points beside the bundle where no source file exists. Every
 * host bundle stages a plain-Node sibling instead; source-mode development keeps
 * using the TypeScript entry through tsx.
 */
export function resolvePrecisionBenchWorkerTarget(
  moduleUrl: string = import.meta.url,
  fileExists: (path: string) => boolean = existsSync,
): PrecisionBenchWorkerTarget {
  const bundledPath = fileURLToPath(new URL('./precision-bench-worker.mjs', moduleUrl));
  if (fileExists(bundledPath)) return { path: bundledPath, runtime: 'node' };
  return {
    path: fileURLToPath(new URL('./precision-bench-worker.ts', moduleUrl)),
    runtime: 'tsx',
  };
}

export function precisionBenchWorkerInvocation(
  target: PrecisionBenchWorkerTarget,
  nodeExecutable = process.execPath,
  tsxExecutable = tsxBin(),
): { command: string; args: string[] } {
  return target.runtime === 'node'
    ? { command: nodeExecutable, args: [target.path] }
    : { command: nodeExecutable, args: [tsxExecutable, target.path] };
}

const PRECISION_BENCH_WORKER = resolvePrecisionBenchWorkerTarget();
const DEFAULT_WORKER_TIMEOUT_MS = PRECISION_BENCH_WORKER_TIMEOUT_MS;

/** How one bench run is asked to measure. */
export interface PrecisionBenchRunOptions {
  /**
   * Measure the Jev-GATED push path, i.e. what the injector does when the
   * workspace's Jev switch is effectively On. False measures the floor alone,
   * which is what production injects in Off and Log only.
   */
  readonly jevGate: boolean;
}

/** Test/seam injection — swap the bench, the DB write, the flag, the invalidation. */
export interface MemoryPrecisionBenchDeps {
  flag?: (installSlug: string) => Promise<boolean>;
  /**
   * The workspace's EFFECTIVE Jev mode (Off unless a key is stored). Tests inject
   * it; the default reads jev-settings. A read failure measures the floor alone.
   */
  jevEffective?: (workspaceId: string) => Promise<'off' | 'shadow' | 'on'>;
  /** Override the actual bench run (tests inject fixed metrics — no embedder, no PG). */
  runBench?: (opts: PrecisionBenchRunOptions) => Promise<MemoryPrecisionMetrics>;
  /** Override the isolated worker path (tests prove the monitor's default route without PG). */
  runBenchWorker?: (opts: PrecisionBenchRunOptions) => Promise<MemoryPrecisionMetrics>;
  /** Override the DB write (tests capture without a live pool). */
  record?: (workspaceId: string, m: MemoryPrecisionMetrics) => Promise<number>;
  /** Override the sync invalidation (tests assert it fired). */
  invalidate?: () => void;
  /**
   * Override the prior-history read the recall-drop baseline is built from
   * (EI-10047). Each prior carries the admission shape it was measured under —
   * WI-7215; a bare r@10 list cannot express which runs are comparable.
   */
  history?: (workspaceId: string) => Promise<PriorRun[]>;
  /** Override the recall-drop escalation (file on alert / resolve on recovery). Tests capture without PG. */
  escalateRecall?: (workspaceId: string, backend: string, rowId: number, evaluation: RecallDropEvaluation) => Promise<void>;
  /**
   * Override the per-fire outcome write (WI-10004133). Every fire records one attempt,
   * so a fire that writes no bench row still leaves its reason behind. Tests capture
   * without PG.
   */
  recordAttempt?: (workspaceId: string, attempt: MemoryPrecisionAttemptInput) => Promise<void>;
  log?: (m: string) => void;
}

export type MemoryPrecisionOutcome =
  | { ran: false; skipReason: 'flag-off' }
  | { ran: false; skipReason: 'failed'; stage: MemoryPrecisionAttemptStage; error: string }
  | { ran: true; metrics: MemoryPrecisionMetrics; rowId: number };

function fmt(v: number | null): string {
  return v == null ? '—' : v.toFixed(3);
}

/** Parse the one-line result emitted by precision-bench-worker.ts. */
export function parsePrecisionBenchWorkerOutput(stdout: string): MemoryPrecisionMetrics {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(PRECISION_BENCH_RESULT_MARKER));
  if (!line) {
    throw new Error(`precision bench worker returned no result marker (stdout=${stdout.slice(-500)})`);
  }
  try {
    return JSON.parse(line.slice(PRECISION_BENCH_RESULT_MARKER.length)) as MemoryPrecisionMetrics;
  } catch (error) {
    throw new Error(
      `precision bench worker returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Run the precision bench in a fresh process. The memory package's configure/client
 * state is process-global, so scheduled inline execution can retarget the operator;
 * this boundary keeps the bench's pid-scoped schema and client out of that process.
 */
export async function runBenchInWorker(opts: {
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
  jevGate?: boolean;
  /** Resolved in the parent, whose memory host carries the live embedder cascade. */
  embedderMode?: string;
  /** Test seam for the parent's stored extraction and embedding credentials. */
  resolveWorkerCredentials?: () => Promise<MemoryCredentials>;
} = {}): Promise<MemoryPrecisionMetrics> {
  const spawnProcess = opts.spawnProcess ?? spawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  let child: ChildProcess;
  try {
    const host = memoryHost();
    const [embedderMode, credentials] = await Promise.all([
      opts.embedderMode === undefined ? host.resolveEmbedder().then(({ mode }) => mode) : Promise.resolve(opts.embedderMode),
      opts.resolveWorkerCredentials ? opts.resolveWorkerCredentials() : host.getCredentials(),
    ]);
    const worker = precisionBenchWorkerInvocation(PRECISION_BENCH_WORKER);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Set explicitly either way, so an inherited value can never gate a floor-only run.
      [PRECISION_BENCH_JEV_GATE_ENV]: opts.jevGate ? '1' : '0',
      [PRECISION_BENCH_EMBEDDER_MODE_ENV]: String(embedderMode),
    };
    if (credentials.openai_api_key !== undefined) env.OPENAI_API_KEY = credentials.openai_api_key;
    if (credentials.anthropic_api_key !== undefined) env.ANTHROPIC_API_KEY = credentials.anthropic_api_key;
    child = spawnProcess(worker.command, worker.args, {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw error;
  }

  return new Promise<MemoryPrecisionMetrics>((resolve, reject) => {
    // Boundary-safe capture: a multi-byte UTF-8 character split across two
    // 'data' events must not decode to replacement chars (WI-6728).
    const { stdout, stderr } = collectChildOutput(child);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* the child may already have exited */
      }
      reject(new Error(`precision bench worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    child.once('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `precision bench worker exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}` +
              (stderr.text().trim() ? `: ${stderr.text().trim().slice(-1_000)}` : ''),
          ),
        );
        return;
      }
      try {
        resolve(parsePrecisionBenchWorkerOutput(stdout.text()));
      } catch (error) {
        reject(error);
      }
    });
  });
}


async function defaultInvalidate(): Promise<void> {
  // Lazy import so the read/test graph never pulls the SSE module.
  try {
    const m = await import('../../sync-sse');
    m.notifySyncInvalidate('learning.knowledge');
    m.notifySyncInvalidate('learning.efficacy');
  } catch {
    /* best-effort */
  }
}

/**
 * The orchestration the `memory-precision:bench` op runs: flag gate → isolated bench →
 * record → invalidate. Every failure is non-fatal (a `failed` outcome, never a
 * throw that wedges the routine tick) — monitoring must never break the loop.
 */
export async function runMemoryPrecisionMonitor(
  input: { workspaceId: string; installSlug: string },
  deps: MemoryPrecisionBenchDeps = {},
): Promise<MemoryPrecisionOutcome> {
  const log = deps.log ?? ((m: string) => console.log(`[memory-precision-bench] ${m}`));
  const flag = deps.flag ?? ((slug: string) => getFlag(FLAGS.MEMORY_PRECISION_BENCH, `routine:${slug}`));
  // WI-10004133: every exit records its outcome durably. Best-effort — an attempt-write
  // failure is logged and never changes the outcome or throws into the routine tick.
  // The attempt ledger follows the record seam: a caller that injects the bench-row write
  // (a test or a dry harness) never writes attempts to the real database by default.
  const injectedAttempt = deps.recordAttempt ?? (deps.record ? async () => {} : undefined);
  const recordAttempt = async (attempt: MemoryPrecisionAttemptInput): Promise<void> => {
    try {
      if (injectedAttempt) {
        await injectedAttempt(input.workspaceId, attempt);
      } else {
        const { getOrgPg } = await import('@papercusp/db-org');
        await recordMemoryPrecisionAttempt(getOrgPg().sql, input.workspaceId, attempt);
      }
    } catch (e) {
      log(`attempt record failed (non-fatal, outcome ${attempt.outcome}): ${e instanceof Error ? e.message : e}`);
    }
  };
  if (!(await flag(input.installSlug))) {
    await recordAttempt({ outcome: 'flag-off' });
    return { ran: false, skipReason: 'flag-off' };
  }

  // P-008: measure what the injector does. Only an EFFECTIVE On (mode on AND a
  // key stored) gates the push path; Off and Log only inject the floor's set.
  let jevGate = false;
  try {
    const effective = deps.jevEffective
      ? await deps.jevEffective(input.workspaceId)
      : (await resolveJevMemoryInjection(input.workspaceId)).effective;
    jevGate = effective === 'on';
  } catch (e) {
    log(`Jev setting read failed (measuring the floor alone): ${e instanceof Error ? e.message : e}`);
  }

  let metrics: MemoryPrecisionMetrics;
  try {
    const run = deps.runBench ?? deps.runBenchWorker ?? ((o: PrecisionBenchRunOptions) => runBenchInWorker({ jevGate: o.jevGate }));
    metrics = await run({ jevGate });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`bench failed (non-fatal): ${error}`);
    await recordAttempt({ outcome: 'failed', stage: 'bench', error, jevGate });
    return { ran: false, skipReason: 'failed', stage: 'bench', error };
  }

  // EI-10047: read the rolling baseline BEFORE this run's own row exists, so
  // the just-recorded number never contaminates the history it's judged
  // against. Best-effort — a history-read failure degrades to
  // 'insufficient-history' (never alerts), it never wedges the record path.
  // WI-7215: priors carry the admission shape they were measured under, so the
  // classifier can drop the incomparable ones. `metrics.notes` is the shape THIS
  // run was measured under — the same string written to the row above — so the
  // comparison can never silently span two measurement regimes.
  let priors: PriorRun[] = [];
  try {
    if (deps.history) {
      priors = await deps.history(input.workspaceId);
    } else {
      const { getOrgPg } = await import('@papercusp/db-org');
      const snap = await readMemoryPrecision(getOrgPg().sql, input.workspaceId, BASELINE_HISTORY_WINDOW);
      priors = snap.trend.map((r) => ({ rAt10: r.rAt10, shape: r.notes ?? null }));
    }
  } catch (e) {
    log(`recall-baseline history read failed (non-fatal, treated as no history): ${e instanceof Error ? e.message : e}`);
  }

  let rowId = 0;
  try {
    if (deps.record) {
      rowId = await deps.record(input.workspaceId, metrics);
    } else {
      const { getOrgPg } = await import('@papercusp/db-org');
      rowId = await recordMemoryPrecisionRun(getOrgPg().sql, input.workspaceId, metrics);
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`record failed (non-fatal): ${error}`);
    await recordAttempt({ outcome: 'failed', stage: 'record', error, jevGate });
    return { ran: false, skipReason: 'failed', stage: 'record', error };
  }
  await recordAttempt({ outcome: 'recorded', rowId, jevGate });

  try {
    if (deps.invalidate) deps.invalidate();
    else await defaultInvalidate();
  } catch {
    /* best-effort — a missed invalidation just delays the panel refresh */
  }

  // EI-10047: alert on a recall-quality drop the routine's own liveness check
  // (learning-loop-health.ts) can't see — it only classifies whether this
  // routine FIRED, not whether what it measured is any good. Best-effort:
  // an escalation failure must never turn a good bench run into a 'failed'
  // outcome, and must never re-throw into the routine tick.
  const evaluation = evaluateRecallDrop(priors, metrics.rAt10, metrics.notes ?? null);
  try {
    if (deps.escalateRecall) {
      await deps.escalateRecall(input.workspaceId, metrics.backend, rowId, evaluation);
    } else if (evaluation.alert) {
      await fileRecallDropEi({ workspaceId: input.workspaceId, backend: metrics.backend, rowId, evaluation });
    } else {
      await resolveRecallDropEi({ workspaceId: input.workspaceId, backend: metrics.backend, rowId, evaluation });
    }
  } catch (e) {
    log(`recall-drop escalation failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }

  log(
    `recorded run #${rowId}: fp@5=${fmt(metrics.fpAt5)} r@10=${fmt(metrics.rAt10)} ` +
      `p@5=${fmt(metrics.pAt5)} mrr=${fmt(metrics.mrr)} (floor ${metrics.floorCosine}/${metrics.floorLex}) ` +
      `shape=${metrics.notes ?? 'untagged'} ` +
      `recall-canary=${evaluation.reason}${evaluation.alert ? ' ALERT' : ''}`,
  );
  return { ran: true, metrics, rowId };
}
