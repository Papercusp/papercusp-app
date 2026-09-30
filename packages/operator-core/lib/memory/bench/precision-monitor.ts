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
import { fileURLToPath } from 'node:url';

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { runGoldSet, seedCorpus, type SeedManifest } from '@papercusp/memory/bench';

import { collectChildOutput } from '../../child-output';
import { pushSearchFloors } from '../injection';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';
import { BENCH_SCOPE, makeBackendCtx } from './run-bench';
import { recordMemoryPrecisionRun, readMemoryPrecision, type MemoryPrecisionMetrics } from './precision-read';
import { evaluateRecallDrop, BASELINE_HISTORY_WINDOW, type PriorRun, type RecallDropEvaluation } from './precision-alert';
import { fileRecallDropEi, resolveRecallDropEi } from './precision-alert-ei';
import { tsxBin } from '../../harness-paths';

const PRECISION_BENCH_WORKER_PATH = fileURLToPath(new URL('./precision-bench-worker.ts', import.meta.url));
export const PRECISION_BENCH_RESULT_MARKER = 'PAPERCUSP_MEMORY_PRECISION_BENCH_RESULT:';
const DEFAULT_WORKER_TIMEOUT_MS = 30 * 60 * 1_000;

/** Test/seam injection — swap the bench, the DB write, the flag, the invalidation. */
export interface MemoryPrecisionBenchDeps {
  flag?: (installSlug: string) => Promise<boolean>;
  /** Override the actual bench run (tests inject fixed metrics — no embedder, no PG). */
  runBench?: () => Promise<MemoryPrecisionMetrics>;
  /** Override the isolated worker path (tests prove the monitor's default route without PG). */
  runBenchWorker?: () => Promise<MemoryPrecisionMetrics>;
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
  log?: (m: string) => void;
}

export type MemoryPrecisionOutcome =
  | { ran: false; skipReason: 'flag-off' }
  | { ran: false; skipReason: 'failed'; error: string }
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
} = {}): Promise<MemoryPrecisionMetrics> {
  const spawnProcess = opts.spawnProcess ?? spawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  let child: ChildProcess;
  try {
    child = spawnProcess(process.execPath, [tsxBin(), PRECISION_BENCH_WORKER_PATH], {
      cwd: process.cwd(),
      env: { ...process.env },
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

/**
 * A run whose corpus did not FULLY seed measures NOTHING: every gold query then
 * searches an empty (or partial) pool and scores 0. Recording that as a metric is
 * strictly WORSE than not running at all —
 *
 *   (a) it reads as a catastrophic recall collapse (r@10 = 0 trips
 *       RECALL_CRITICAL_FLOOR), so the canary cries wolf on every run, and
 *   (b) it POISONS the rolling baseline the canary judges future runs against:
 *       a zeroed median can never exhibit a 'baseline-drop' again, disarming the
 *       very detector this bench exists to feed.
 *
 * EI-10793 caught this live — `bench_memory.memory_vec_harrier` was missing, all
 * 114/114 seeds failed, and THREE consecutive all-zero runs were recorded as
 * legitimate measurements while nothing alarmed — and explicitly left the detector
 * open: "a run where a backend seeds 0/N should arguably hard-fail". This is that
 * detector.
 *
 * Throwing is the correct LOUD failure: `runMemoryPrecisionMonitor` catches it into
 * `{ ran: false, skipReason: 'failed' }` — no row written, no escalation fired, the
 * error logged — and a bench that stops producing rows is visible to the routine's
 * own liveness check. A silent zero is invisible to both.
 *
 * Strict on PARTIAL seeds too, deliberately: the gold set's expected-hit
 * denominators are keyed to the FULL corpus, so a missing document silently
 * understates r@10 — i.e. it fakes a recall regression. A measuring instrument that
 * quietly measures a different corpus than the one it reports is not usable.
 */
export function assertCorpusSeeded(manifest: SeedManifest, expected: number): void {
  const seeded = Object.keys(manifest.ids).length;
  if (seeded === expected && manifest.failed.length === 0) return;
  const sample = manifest.failed.slice(0, 3).join(', ');
  throw new Error(
    `corpus seed incomplete: ${seeded}/${expected} seeded, ${manifest.failed.length} failed` +
      (sample ? ` (e.g. ${sample})` : '') +
      ` — refusing to record a run. An unseeded corpus scores 0 for INFRASTRUCTURE reasons, not recall ` +
      `reasons; recording it would false-alarm the recall canary and poison its baseline (EI-10793).`,
  );
}

/**
 * Run the floored hybrid gold-set ONCE and return the metrics (no DB write).
 * Exported for a CLI / one-off seeding run and for the isolated worker's core.
 */
export async function benchMemoryPrecision(): Promise<MemoryPrecisionMetrics> {
  const corpus = loadCorpusFixture('v1');
  const gold = loadGoldSetFixture('v1');
  const ctx = await makeBackendCtx('hybrid', false);
  try {
    const manifest = await seedCorpus(ctx.backend, corpus, { scope: BENCH_SCOPE, verbatim: true, concurrency: 8 });
    // The manifest was previously DISCARDED — which is exactly how a total seed
    // failure became "recall = 0" instead of "the bench could not run".
    assertCorpusSeeded(manifest, corpus.length);
    // WI-7179: read all three admission values from pushSearchFloors() — the
    // SAME constructor `buildBlockInner` runs for the live push path — instead
    // of re-declaring them. A copied constant (the old `fusionMode:
    // 'floored-union'` literal below, paired with imported floor constants)
    // cannot notice production has moved on: D-010 flipped the push default to
    // `cosine-gated` and this monitor kept measuring the retired shape, which
    // is precisely the failure mode `pushSearchFloors()`'s own doc comment
    // names this file as the example of. Pattern proven on floor-sweep-cli.ts.
    const f = pushSearchFloors();
    const retrieval = await runGoldSet(ctx.backend, gold.queries, {
      scope: BENCH_SCOPE,
      limit: 10,
      concurrency: 4,
      // Measure the EXACT production push floor — the whole point is monitoring
      // the LIVE injector's precision, not the unfloored raw-recall number.
      minScore: f.minScore,
      minLexScore: f.minLexScore,
      fusionMode: f.fusionMode,
    });
    const hardNeg = retrieval.byClass['hard-negative'];
    return {
      backend: ctx.backend.name,
      corpusVersion: 'v1',
      goldVersion: gold.version,
      corpusN: corpus.length,
      goldN: gold.queries.length,
      floorCosine: f.minScore ?? 0,
      floorLex: f.minLexScore ?? 0,
      fpAt5: hardNeg?.fpAt5 ?? null,
      rAt10: retrieval.overall.r10,
      pAt5: retrieval.overall.p5,
      mrr: retrieval.overall.mrr,
      medianTopScore: retrieval.overall.medianTopScore ?? null,
      latencyP50Ms: retrieval.latency.p50,
      byClass: retrieval.byClass as Record<string, unknown>,
      // Embedding cost is not separately metered here (small, no LLM); left null.
      costUsd: null,
      // WI-7179: tag the admission shape onto the row (no schema migration —
      // `notes` already exists). Rows recorded before this fix carry no tag and
      // were measured under `floored-union`; a human (or the recall-drop
      // canary's next reader) comparing across this boundary should expect a
      // real one-time step-change here, not a regression — see WI-7179's
      // completion note for why the pre-fix history isn't a valid baseline.
      notes: `fusionMode:${f.fusionMode}`,
    };
  } finally {
    // A cleanup failure (e.g. a held pooled connection) must never lose the run;
    // makeBackendCtx already drops the bench schema. Swallow non-fatally.
    await ctx.cleanup().catch(() => {});
  }
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
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  let metrics: MemoryPrecisionMetrics;
  try {
    metrics = await (deps.runBench ?? deps.runBenchWorker ?? runBenchInWorker)();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`bench failed (non-fatal): ${error}`);
    return { ran: false, skipReason: 'failed', error };
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
    return { ran: false, skipReason: 'failed', error };
  }

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
      `recall-canary=${evaluation.reason}${evaluation.alert ? ' ALERT' : ''}`,
  );
  return { ran: true, metrics, rowId };
}
