/**
 * Read-only git classification + the client-side latency window for sidecar git
 * reads (WI-10004674 / WI-10003465).
 *
 * TWO concerns, ONE module, because both answer "is this exec a read-only git
 * read?" and must never disagree about it:
 *
 *  1. `qualifiesForLazyReceipt` — the classification `sidecar-exec-process.ts`
 *     uses to defer the durable admission receipt. MOVED here verbatim (it is
 *     re-exported from `sidecar-exec-process.ts`, so existing importers are
 *     unaffected) so the CLIENT side can reuse it without importing the
 *     resource-governor / PG chain `sidecar-exec-process.ts` drags in.
 *
 *  2. A rolling window of per-read wall latency, recorded by the CLIENT
 *     (`runCommandViaSpawnerSidecar`) around the `process:exec` round-trip.
 *
 * WHY THE LATENCY IS MEASURED HERE AND NOT READ FROM THE RECEIPT LEDGER. The
 * first draft of the guard graded `resource_governor_admissions` enqueue→complete
 * p50. That is unsound AFTER the lazy-receipt fix: a fast read mints NO receipt,
 * so the ledger only ever holds the reads slower than the lazy delay — a p50 over
 * a population selected FOR being slow, which reads high by construction and
 * would stay red on a healthy system. The client sees every read, receipt or not.
 *
 * SCOPE OF THE READING. The window lives in the process that made the calls, so it
 * describes THAT process's own sidecar reads — which is the one the symptom is
 * reported from (`dev:pipeline_position` runs in the operator host). A process
 * that issued too few reads reports `sample` below the floor and no verdict; the
 * consumer must say "not measured", never "healthy".
 */
import * as path from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';

/**
 * Subcommands that read repository state and cannot fire a hook, so a late
 * receipt never loses nested-process lineage worth keeping. `commit`, `push`,
 * `fetch`, `checkout`, `merge`, `status` (fsmonitor hook) and anything unknown
 * stay eager.
 */
export const LAZY_RECEIPT_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'cat-file',
  'check-ref-format',
  'config',
  'describe',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'for-each-ref',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'name-rev',
  'rev-list',
  'rev-parse',
  'show',
  'show-ref',
  'symbolic-ref',
  'var',
]);
const GIT_GLOBAL_OPTIONS_WITH_SEPARATE_VALUE: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
]);
const GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  '--no-pager',
  '--no-optional-locks',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--bare',
]);

/** The git subcommand after its global options, or null when the argv is not understood. */
export function gitSubcommandOf(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) return arg;
    if (GIT_GLOBAL_OPTIONS_WITH_SEPARATE_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace)=/.test(arg) || GIT_GLOBAL_FLAGS.has(arg)) continue;
    // An option this parser does not know could swallow the next token; do not guess.
    return null;
  }
  return null;
}

export function qualifiesForLazyReceipt(params: { command: string; args?: readonly string[] }): boolean {
  if (path.basename(params.command) !== 'git') return false;
  const sub = gitSubcommandOf(params.args ?? []);
  return sub !== null && LAZY_RECEIPT_GIT_SUBCOMMANDS.has(sub);
}

/** How far back a reading looks. Matches the rig's 15-minute sampling cadence. */
export const SIDECAR_READ_LATENCY_WINDOW_MS = 15 * 60_000;
/** Hard cap on retained samples (oldest dropped first) — bounds memory under any call rate. */
export const SIDECAR_READ_LATENCY_MAX_SAMPLES = 2048;

interface LatencySample {
  readonly atMs: number;
  readonly ms: number;
}

const latencyState = pinModuleState<{ samples: LatencySample[] }>(
  '@papercusp/operator-core.fleet.sidecar-read-only-git.latency',
  () => ({ samples: [] }),
);

/**
 * Record one completed sidecar exec. Only read-only git reads are kept — a
 * `fetch`/`commit`/`push` is slow by nature and would drown the per-read signal.
 * Never throws: a latency observer must not be able to fail the exec it observes.
 */
export function recordSidecarExecLatency(
  params: { command: string; args?: readonly string[] },
  elapsedMs: number,
  nowMs: number = Date.now(),
): void {
  try {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    if (!qualifiesForLazyReceipt(params)) return;
    const { samples } = latencyState;
    samples.push({ atMs: nowMs, ms: elapsedMs });
    if (samples.length > SIDECAR_READ_LATENCY_MAX_SAMPLES) {
      samples.splice(0, samples.length - SIDECAR_READ_LATENCY_MAX_SAMPLES);
    }
  } catch {
    /* observer only */
  }
}

export interface SidecarReadLatencyReading {
  /** Reads inside the window. */
  readonly sample: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly windowMs: number;
}

/** Nearest-rank percentile of an ascending-sorted, non-empty array. */
function nearestRank(sortedAsc: readonly number[], q: number): number {
  const rank = Math.max(1, Math.ceil(q * sortedAsc.length));
  return sortedAsc[Math.min(rank, sortedAsc.length) - 1]!;
}

export function readSidecarReadLatency(
  opts: { nowMs?: number; windowMs?: number } = {},
): SidecarReadLatencyReading {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? SIDECAR_READ_LATENCY_WINDOW_MS;
  const inWindow = latencyState.samples
    .filter((s) => s.atMs >= nowMs - windowMs && s.atMs <= nowMs)
    .map((s) => s.ms)
    .sort((a, b) => a - b);
  if (inWindow.length === 0) return { sample: 0, p50Ms: null, p95Ms: null, windowMs };
  return {
    sample: inWindow.length,
    p50Ms: nearestRank(inWindow, 0.5),
    p95Ms: nearestRank(inWindow, 0.95),
    windowMs,
  };
}

/** Test seam: drop every recorded sample. */
export function resetSidecarReadLatencyForTest(): void {
  latencyState.samples.length = 0;
}
