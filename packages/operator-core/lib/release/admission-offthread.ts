/**
 * WI-10005223: run frozen-repair ADMISSION git work OFF the operator's main thread.
 *
 * `release:repair-queue` admission used to call the sync builders directly from the tool
 * handler, so every `spawnSync('git')` of an admission sequence blocked the operator event
 * loop: measured avg 4.3-12.4s per admit, max 61.8s — past the event-loop sentinel's 20s
 * wedge-kill, i.e. one slow admit could SIGKILL the host and drop every MCP session on it.
 *
 * The builders are unchanged. This host ships each call as a plain-data job
 * (admission-jobs.ts) to ONE persistent worker thread and awaits the result:
 *
 * - **Serialized with fail-fast backpressure.** The builders' documented invariant ("a sync
 *   sequence cannot be interleaved with a second admission in the same process") is enforced
 *   with one in-flight job. Concurrent submissions are refused with
 *   AdmissionOffthreadBusyError rather than retained in an unbounded in-memory Promise chain;
 *   callers can retry after the current job settles.
 * - **Persistent, idle-reaped.** Loading the worker costs ~0.6-0.75s (tsx) or a bundle parse,
 *   so one worker serves every job and is terminated after `idleMs` with nothing pending.
 * - **Inline only on LOAD failure.** If the worker cannot start (missing entry, loader error,
 *   no `ready` within the deadline), the job runs inline — today's behaviour, loudly logged,
 *   for a cooldown window. A worker that dies MID-job rejects that job instead: re-running an
 *   admission inline could repeat a publish whose outcome is unknown.
 *
 * Entry resolution mirrors the event-loop sentinel: the bundled hosts (`node dist-host/
 * hono-host.mjs` — :3070, :3170, bg-host, packaged desktop, rig) load the esbuilt
 * `admission-jobs.worker.mjs` staged beside the bundle by bundle-host-common.sh; an unbundled
 * run (tsx dev, vitest) loads the `admission-jobs.tsx-worker.mjs` bootstrap, which registers
 * tsx on the worker thread because worker threads do not inherit the parent's loader hooks.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  executeAdmissionJob,
  type AdmissionJob,
  type AdmissionJobKind,
  type AdmissionJobOf,
  type AdmissionJobResults,
  type AdmissionWorkerRequest,
  type AdmissionWorkerResponse,
} from './admission-jobs';

export const ADMISSION_WORKER_BUNDLED = 'admission-jobs.worker.mjs';
export const ADMISSION_WORKER_TSX_BOOTSTRAP = 'admission-jobs.tsx-worker.mjs';

const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_LOAD_DEADLINE_MS = 30_000;
const DEFAULT_LOAD_FAILURE_COOLDOWN_MS = 5 * 60_000;

export interface AdmissionOffthreadConfig {
  /** `inline` runs every job on the calling thread (today's behaviour). Default `worker`. */
  mode: 'worker' | 'inline';
  /** Override the worker entry (tests). Default: bundled `.mjs` beside this module, else the tsx bootstrap. */
  workerPath: string | null;
  idleMs: number;
  loadDeadlineMs: number;
  loadFailureCooldownMs: number;
}

export interface AdmissionOffthreadStats {
  jobsOnWorker: number;
  jobsInline: number;
  loadFailures: number;
  lastLoadError: string | null;
  inlineUntilMs: number;
  workerLive: boolean;
}

interface Pending {
  id: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

interface HostState {
  config: AdmissionOffthreadConfig;
  activeJob: Promise<unknown> | null;
  worker: Worker | null;
  ready: Promise<Worker> | null;
  retiring: Promise<void> | null;
  pending: Pending | null;
  nextId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stats: AdmissionOffthreadStats;
}

export class AdmissionOffthreadBusyError extends Error {
  readonly code = 'ADMISSION_OFFTHREAD_BUSY';

  constructor() {
    super('an admission job is already running in this process; retry after it settles');
    this.name = 'AdmissionOffthreadBusyError';
  }
}

export interface AdmissionJobRunOptions {
  /** Opt-in execution bound. Only callers whose job is safe to abandon should set this. */
  timeoutMs?: number;
  /** Operation label included in a timeout result, e.g. `build-proof`. */
  stepName?: string;
}

export class AdmissionOffthreadTimeoutError extends Error {
  readonly code = 'ADMISSION_OFFTHREAD_TIMEOUT';

  constructor(
    readonly jobKind: AdmissionJobKind,
    readonly timeoutMs: number,
    readonly stepName?: string,
  ) {
    super(`admission ${stepName ?? jobKind} exceeded its ${timeoutMs}ms execution deadline`);
    this.name = 'AdmissionOffthreadTimeoutError';
  }
}

export class AdmissionOffthreadTimeoutUnavailableError extends Error {
  readonly code = 'ADMISSION_OFFTHREAD_TIMEOUT_UNAVAILABLE';

  constructor(
    readonly jobKind: AdmissionJobKind,
    readonly detail: string,
    readonly stepName?: string,
  ) {
    super(`cannot enforce the ${stepName ?? jobKind} admission timeout: ${detail}`);
    this.name = 'AdmissionOffthreadTimeoutUnavailableError';
  }
}

const defaultConfig = (): AdmissionOffthreadConfig => ({
  mode: 'worker',
  workerPath: null,
  idleMs: DEFAULT_IDLE_MS,
  loadDeadlineMs: DEFAULT_LOAD_DEADLINE_MS,
  loadFailureCooldownMs: DEFAULT_LOAD_FAILURE_COOLDOWN_MS,
});

const freshStats = (): AdmissionOffthreadStats => ({
  jobsOnWorker: 0,
  jobsInline: 0,
  loadFailures: 0,
  lastLoadError: null,
  inlineUntilMs: 0,
  workerLive: false,
});

// Pinned: a split module record would mean two FIFO chains and two workers, and the
// one-admission-in-flight invariant this module exists to preserve would silently break.
const state = pinModuleState<HostState>('@papercusp/operator-core.release.admission-offthread', () => ({
  config: defaultConfig(),
  activeJob: null,
  worker: null,
  ready: null,
  retiring: null,
  pending: null,
  nextId: 1,
  idleTimer: null,
  stats: freshStats(),
}));

/** Where the worker entry lives for a host whose executing module sits in `dir`. */
export function admissionWorkerEntry(dir: string = moduleDir()): string {
  const bundled = join(dir, ADMISSION_WORKER_BUNDLED);
  return existsSync(bundled) ? bundled : join(dir, ADMISSION_WORKER_TSX_BOOTSTRAP);
}

function moduleDir(): string {
  const here = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  return dirname(here);
}

export function configureAdmissionOffthread(patch: Partial<AdmissionOffthreadConfig>): void {
  state.config = { ...state.config, ...patch };
}

export function admissionOffthreadStats(): AdmissionOffthreadStats {
  return { ...state.stats, workerLive: state.worker !== null };
}

/** Terminate the worker and restore defaults. Waits for the active job to settle first. */
export async function resetAdmissionOffthread(): Promise<void> {
  await state.activeJob?.catch(() => undefined);
  await terminateWorker();
  state.config = defaultConfig();
  state.stats = freshStats();
}

/**
 * Run one admission job. Resolves with exactly what the sync builder returns, and rejects
 * with exactly what it throws (name/message/stack preserved across the thread boundary).
 */
export function runAdmissionJob<K extends AdmissionJobKind>(
  job: AdmissionJobOf<K>,
  options: AdmissionJobRunOptions = {},
): Promise<AdmissionJobResults[K]> {
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    return Promise.reject(new RangeError('admission job timeoutMs must be a positive integer'));
  }
  if (state.activeJob !== null) return Promise.reject(new AdmissionOffthreadBusyError());
  let active!: Promise<AdmissionJobResults[K]>;
  active = Promise.resolve()
    .then(() => runOne(job, options))
    .finally(() => {
      if (state.activeJob === active) state.activeJob = null;
    }) as Promise<AdmissionJobResults[K]>;
  state.activeJob = active;
  return active;
}

async function runOne(job: AdmissionJob, options: AdmissionJobRunOptions): Promise<unknown> {
  if (state.config.mode === 'inline' || Date.now() < state.stats.inlineUntilMs) {
    if (options.timeoutMs !== undefined) {
      throw new AdmissionOffthreadTimeoutUnavailableError(
        job.kind,
        state.config.mode === 'inline' ? 'inline mode is active' : 'the worker load-failure cooldown is active',
        options.stepName,
      );
    }
    state.stats.jobsInline++;
    return executeAdmissionJob(job);
  }
  let worker: Worker;
  try {
    worker = await ensureWorker();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.stats.loadFailures++;
    state.stats.lastLoadError = message.slice(0, 500);
    state.stats.inlineUntilMs = Date.now() + state.config.loadFailureCooldownMs;
    if (options.timeoutMs !== undefined) {
      throw new AdmissionOffthreadTimeoutUnavailableError(job.kind, message.slice(0, 500), options.stepName);
    }
    console.error(
      `[admission-offthread] admission worker failed to load (${message.slice(0, 300)}); ` +
        `running admission git INLINE on the main thread for ${Math.round(state.config.loadFailureCooldownMs / 1000)}s ` +
        '(WI-10005223: this blocks the event loop exactly as before the off-thread move)',
    );
    state.stats.jobsInline++;
    return executeAdmissionJob(job);
  }
  state.stats.jobsOnWorker++;
  return dispatch(worker, job, options);
}

function ensureWorker(): Promise<Worker> {
  if (state.retiring) {
    const retiring = state.retiring;
    return retiring.then(() => ensureWorker());
  }
  if (state.ready) return state.ready;
  const entry = state.config.workerPath ?? admissionWorkerEntry();
  const ready = new Promise<Worker>((resolve, reject) => {
    let worker: Worker;
    try {
      // execArgv:[] — a clean thread: the tsx bootstrap registers its own loader, and the
      // bundled entry is plain JS. SHARE_ENV — git sees the same process.env as inline did.
      worker = new Worker(entry, { env: SHARE_ENV, execArgv: [] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let loaded = false;
    const deadline = setTimeout(() => {
      if (loaded) return;
      settleLoad(new Error(`admission worker did not report ready within ${state.config.loadDeadlineMs}ms`));
      void worker.terminate();
    }, state.config.loadDeadlineMs);
    deadline.unref?.();
    const settleLoad = (err: Error | null) => {
      if (loaded) return;
      loaded = true;
      clearTimeout(deadline);
      if (err) {
        if (state.worker === worker) state.worker = null;
        state.ready = null;
        reject(err);
      } else {
        resolve(worker);
      }
    };
    worker.on('message', (message: AdmissionWorkerResponse) => {
      if (message?.type === 'ready') {
        state.worker = worker;
        worker.unref();
        armIdle();
        settleLoad(null);
        return;
      }
      if (message?.type === 'result') onResult(worker, message);
    });
    worker.on('error', (err) => {
      if (!loaded) settleLoad(err);
      else failWorker(worker, err);
    });
    worker.on('exit', (code) => {
      if (!loaded) settleLoad(new Error(`admission worker exited during load (code ${code})`));
      else failWorker(worker, new Error(`admission worker exited (code ${code})`));
    });
  });
  state.ready = ready;
  return ready;
}

function dispatch(worker: Worker, job: AdmissionJob, options: AdmissionJobRunOptions): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (state.pending !== null) {
      reject(new AdmissionOffthreadBusyError());
      return;
    }
    const id = state.nextId++;
    clearIdle();
    const pending: Pending = { id, resolve, reject, timeoutTimer: null };
    state.pending = pending;
    if (options.timeoutMs !== undefined) {
      pending.timeoutTimer = setTimeout(() => {
        if (state.pending?.id !== id) return;
        state.pending = null;
        pending.timeoutTimer = null;
        clearIdle();
        if (state.worker === worker) {
          // This timeout is opt-in and reserved for read-only previews. Discard the worker so
          // its synchronous builder cannot monopolize the one-job lane after the caller returns.
          state.worker = null;
          state.ready = null;
          void retireWorker(worker);
        }
        reject(new AdmissionOffthreadTimeoutError(job.kind, options.timeoutMs!, options.stepName));
      }, options.timeoutMs);
      pending.timeoutTimer.unref?.();
    }
    // Keep the process alive while a job is in flight; idle workers never do.
    worker.ref();
    try {
      worker.postMessage({ id, job } satisfies AdmissionWorkerRequest);
    } catch (err) {
      if (state.pending?.id === id) {
        if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
        pending.timeoutTimer = null;
        state.pending = null;
      }
      settleIdle(worker);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function onResult(worker: Worker, message: Extract<AdmissionWorkerResponse, { type: 'result' }>): void {
  const pending = state.pending;
  if (!pending || pending.id !== message.id) return;
  if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
  pending.timeoutTimer = null;
  state.pending = null;
  settleIdle(worker);
  if (message.ok) {
    pending.resolve(message.value);
    return;
  }
  const err = new Error(message.error.message);
  err.name = message.error.name;
  if (message.error.stack) err.stack = `${message.error.stack}\n    at <admission worker thread>`;
  pending.reject(err);
}

/** A worker that dies after `ready` fails every in-flight job; the next job starts a fresh worker. */
function failWorker(worker: Worker, err: Error): void {
  // A worker WE retired (idle reap, reset) is no longer `state.worker` when its exit event
  // lands. Its jobs had all settled, and a successor may already own `pending` and the idle
  // timer — touching either would fail the successor's in-flight job.
  if (state.worker !== worker) return;
  state.worker = null;
  state.ready = null;
  clearIdle();
  const pending = state.pending;
  state.pending = null;
  if (pending) {
    if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
    pending.timeoutTimer = null;
    pending.reject(new Error(`admission worker failed mid-job: ${err.message}`));
  }
  void retireWorker(worker);
}

function settleIdle(worker: Worker): void {
  if (state.pending !== null) return;
  worker.unref();
  armIdle();
}

function armIdle(): void {
  clearIdle();
  const timer = setTimeout(() => {
    state.idleTimer = null;
    if (state.activeJob === null && state.pending === null) void terminateWorker();
  }, state.config.idleMs);
  timer.unref?.();
  state.idleTimer = timer;
}

function clearIdle(): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = null;
}

async function terminateWorker(): Promise<void> {
  clearIdle();
  if (state.retiring) {
    await state.retiring;
    return;
  }
  const worker = state.worker;
  state.worker = null;
  state.ready = null;
  if (worker) await retireWorker(worker);
}

function retireWorker(worker: Worker): Promise<void> {
  if (state.retiring) return state.retiring;
  let retiring!: Promise<void>;
  retiring = worker
    .terminate()
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (state.retiring === retiring) state.retiring = null;
    });
  state.retiring = retiring;
  return retiring;
}
