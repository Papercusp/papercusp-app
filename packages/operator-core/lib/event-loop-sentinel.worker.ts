/**
 * event-loop-sentinel.worker.ts — the sentinel body, running on a
 * `worker_threads` Worker so it keeps ticking while the MAIN event loop is
 * blocked. Started by `event-loop-sentinel-host.ts`; the decision itself lives
 * in the pure `event-loop-sentinel.ts`.
 *
 * ## Three measured facts this file is built on
 *
 * All three were verified empirically (2026-08-04, EI-19465075959589134) rather
 * than assumed, because each one silently breaks the feature if wrong.
 *
 * 1. **A worker keeps running while the main thread spins.** Probe: main thread
 *    blocked 3000 ms; the worker observed the freeze and decided at 600 ms of
 *    staleness. Had it been blocked too it would have reported ~3000 ms after
 *    the fact. This is the premise of the whole design.
 *
 * 2. **`console.log` from a worker DOES NOT ESCAPE a blocked main thread.** It
 *    is proxied through the parent port, so it queues behind the block — in the
 *    probe it printed only *after* the main loop was released. Since we SIGKILL,
 *    the process would die before it ever flushed: a mysterious death with no
 *    log line. `fs.writeSync(2, …)` goes straight to fd 2 and DID print during
 *    the block. **Never use console/`process.stderr.write` in this file.**
 *
 * 3. **This file may be `.ts`.** The repo convention for worker bodies is plain
 *    `.mjs` (`cpu-task-worker.script.mjs`) precisely to avoid a TypeScript
 *    transform in a worker. Measured: a Worker spawned from the tsx-run host
 *    (`npx tsx bin/hono-host.ts`) resolves and imports repo `.ts` fine. Staying
 *    in `.ts` lets this file import the SAME decider the tests exercise, which
 *    matters more here than convention — a hand-copied `.mjs` state machine
 *    could drift from the tested one, and a drifted copy of *this* logic
 *    SIGKILLs production. Spawn failure is handled fail-soft by the host, so a
 *    runtime where this does not load simply disables the sentinel.
 *
 * ## Why SIGKILL and not SIGTERM / process.exit
 *
 * - `process.exit()` in a worker exits only the WORKER thread, not the process.
 * - `SIGTERM` runs a JS handler, which is queued on the blocked main loop — it
 *   would never execute. The whole point is that the loop cannot run JS.
 * - `SIGKILL` is delivered by the kernel and needs no cooperation from the
 *   process. systemd then restarts it (a signal death is a failure, so this
 *   restarts under `Restart=on-failure` as well as `Restart=always` — the same
 *   property `memory-watchdog.ts` buys with its non-zero exit code).
 */

import { workerData, parentPort } from 'node:worker_threads';
import { Session } from 'node:inspector';
import { join } from 'node:path';
import {
  writeSync,
  readFileSync,
  readlinkSync,
  openSync,
  readSync,
  closeSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
// EXPLICIT `.ts` EXTENSION IS LOAD-BEARING (see the sentinel import below).
// prettier-ignore
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — the plain-node Worker requires an explicit .ts specifier; apps/operator does not enable allowImportingTsExtensions.
import { STALL_PROFILE_DEFAULTS, hotStackFields, shouldCaptureStallProfile, summarizeHotStacks, syncSpawnProducer, type CpuProfileLike, type StallProfileConfig } from './event-loop-stall-profile.ts';
// EXPLICIT `.ts` EXTENSION IS LOAD-BEARING for the same reason as the import
// below — this is a worker ENTRY, loaded by Node's native type stripping, which
// has no extensionless lookup. `proc-thread-cpu.ts` is dependency-free and
// syntax-plain precisely so it is safe to pull in here.
// prettier-ignore
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — the plain-node Worker requires an explicit .ts specifier; apps/operator does not enable allowImportingTsExtensions.
import {
  classifyThreadCpu,
  isConfirmedCpuStarvation,
  isConfirmedHostIoWait,
  isLikelySyncSubprocessBlock,
  parseCpuPressureSomeAvg60,
  parseProcDirectoryFd,
  parseProcStat,
  parseProcSyscallTarget,
  decodeProcPath,
  AT_FDCWD,
  type MainThreadActivity,
} from './proc-thread-cpu.ts';
// EXPLICIT `.ts` EXTENSION IS LOAD-BEARING — do not "tidy" it away.
//
// This module is a Worker ENTRY. Worker threads do NOT inherit the parent's
// registered ESM loader hooks, so under `npx tsx bin/hono-host.ts` (bg-host,
// dev, desktop sidecar) this file is loaded by NODE'S NATIVE type stripping,
// not by tsx — and native stripping uses standard ESM resolution, which has
// no extensionless lookup. An extensionless specifier here therefore throws
// `Cannot find module …/event-loop-sentinel` INSIDE the worker, and because
// the host is fail-soft that surfaces only as "sentinel disabled, host
// unaffected" milliseconds after it already logged "armed".
//
// Measured 2026-08-10: 57 arm-then-die cycles in 24h on papercup-bg-host,
// leaving the routines host unguarded — during which it wedged its event loop
// for 23 minutes (1.13 cores, 101 routines frozen) with nothing to kill it,
// exactly the outage this sentinel was built to bound at ~24s.
// Guarded by worker-entry-plain-node-loadable.test.ts.
// prettier-ignore
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — the plain-node Worker requires an explicit .ts specifier; apps/operator does not enable allowImportingTsExtensions.
import { decideLoopSentinelAction, initialLoopSentinelState, SENTINEL_SAB_IDX, type LoopSentinelState, type LoopSentinelThresholds } from './event-loop-sentinel.ts';

export interface SentinelWorkerData {
  sab: SharedArrayBuffer;
  thresholds: LoopSentinelThresholds;
  observeIntervalMs: number;
  /** 'kill' arms the SIGKILL; 'observe' logs what it WOULD do and never kills. */
  mode: 'kill' | 'observe';
  /** Owning process pid — signalled on a confirmed wedge. */
  pid: number;
  /**
   * Bounded in-stall main-thread diagnostic (WI-10004766, WI-10005529). Absent or
   * null disables it; the host always passes its config.
   */
  stallProfile?: StallProfileConfig | null;
}

/**
 * Structured line straight to fd 2 (see fact 2 above). Shaped like the
 * memory-watchdog's lines so both watchdogs read alike in the journal.
 */
function emit(line: string, detail: Record<string, string | number | boolean>): void {
  try {
    const fields = Object.entries(detail)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : String(v)}`)
      .join(', ');
    writeSync(2, `[event-loop-sentinel] ${line} { ${fields} }\n`);
  } catch {
    /* a diagnostic must never take down the sentinel */
  }
}

const data = workerData as SentinelWorkerData;
const view = new Int32Array(data.sab);
const { thresholds, observeIntervalMs, mode, pid } = data;

/**
 * EI-19484853609145439: the loop-lag monitor (`event-loop-lag-monitor.ts`)
 * publishes its last-read percentiles into this SAME SharedArrayBuffer, at the
 * indices `SENTINEL_SAB_IDX` reserves for it — a plain `Atomics.store` from the
 * main thread's own timer, no reply needed, so it survives a block exactly
 * like the heartbeat counter does. Reading it here turns a silent wedge into
 * "last observed p95 lag Xms" instead of nothing: the lag monitor's own reader
 * shares fate with the loop and never gets to report this value itself once a
 * real block starts, but the LAST value it read before the block began is
 * still sitting in shared memory for us to read off-thread.
 *
 * The SAB is zero-initialized, so a process where the lag monitor was never
 * wired to publish here (or hasn't ticked yet) reads all-zero — reported as-is
 * rather than hidden, since it is best-effort diagnostics, not a boolean gate.
 */
function lastKnownLag(): Record<string, number> {
  return {
    lastLagP50Ms: Atomics.load(view, SENTINEL_SAB_IDX.LAG_P50_MS),
    lastLagP95Ms: Atomics.load(view, SENTINEL_SAB_IDX.LAG_P95_MS),
    lastLagP99Ms: Atomics.load(view, SENTINEL_SAB_IDX.LAG_P99_MS),
    lastLagMaxMs: Atomics.load(view, SENTINEL_SAB_IDX.LAG_MAX_MS),
  };
}

/**
 * WHAT the main thread was doing while it was stalled — the one thing the kill
 * line never used to say.
 *
 * A wedge has two completely different causes that the staleness number cannot
 * tell apart, and which need opposite fixes:
 *
 *   - the thread is SPINNING (a synchronous JS loop, a pathological regex, GC
 *     thrash) — CPU is being burned and a stack sample is the next step;
 *   - the thread is PARKED in a blocking syscall — CPU is ~zero and `state`/
 *     `wchan` name what it is waiting on.
 *
 * Both look identical from staleness alone, so every occurrence used to teach us
 * nothing and the investigation restarted from scratch. We read it off `/proc`
 * from THIS thread, which keeps running while the main thread does not — the
 * same off-thread trick `lastKnownLag()` uses, and the only kind that can work
 * when the subject cannot execute JS to report on itself.
 *
 * Per-THREAD path (`/task/<pid>/`), never the process-wide one: the process
 * total includes every worker and would report "busy" about a parked main
 * thread sitting beside busy children.
 */
function readMainThreadStat(): { state: string; ticks: number } | null {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/task/${pid}/stat`, 'utf8'));
  } catch {
    return null; // not Linux, or the process is gone — unknown, never zero.
  }
}

function readMainThreadWchan(): string | null {
  try {
    const w = readFileSync(`/proc/${pid}/task/${pid}/wchan`, 'utf8').trim();
    return w === '' || w === '0' ? null : w;
  } catch {
    return null;
  }
}

function readCpuPressureSomeAvg60(): number | null {
  try {
    return parseCpuPressureSomeAvg60(readFileSync('/proc/pressure/cpu', 'utf8'));
  } catch {
    return null; // non-Linux, unavailable procfs, or a transient read race
  }
}

/**
 * Attribute an `iterate_dir` block to the actual directory being enumerated.
 *
 * External `strace -p` is commonly denied by Yama/ptrace policy on the hosts
 * this sentinel protects. The worker is already inside the target process, so
 * it can instead read the main thread's current syscall, take getdents64 arg0,
 * and resolve that fd through `/proc/<pid>/fd`. Re-reading wchan after the
 * lookup prevents a thread that recovered mid-probe from leaving behind a
 * plausible but stale path in the kill record.
 */
function readMainThreadDirectoryWait(wchan: string | null): Record<string, string | number> {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/syscall`, 'utf8');
    const fd = parseProcDirectoryFd(raw, wchan);
    if (fd == null) return {};
    const directory = readlinkSync(`/proc/${pid}/fd/${fd}`);
    if (readMainThreadWchan() !== wchan) return {};
    return {
      mainThreadBlockedDirectoryFd: fd,
      mainThreadBlockedDirectory: directory.slice(0, 240),
    };
  } catch {
    return {}; // transient syscall/fd race, non-Linux, or unreadable procfs
  }
}

/** Read a NUL-terminated path at `ptr` in this process's own memory, without crossing a page. */
function readOwnMemoryPath(ptr: number): string | null {
  const len = Math.min(512, 4096 - (ptr % 4096));
  const buf = new Uint8Array(len);
  let fd: number | null = null;
  try {
    fd = openSync(`/proc/${pid}/mem`, 'r');
    return decodeProcPath(buf, readSync(fd, buf, 0, len, ptr));
  } catch {
    return null;
  } finally {
    if (fd != null) try { closeSync(fd); } catch { /* best effort */ }
  }
}

/**
 * Name the syscall and FILE behind a D-state main-thread stall (WI-10004754).
 *
 * The wait channel alone (`open_last_lookups`, `lookup_slow`,
 * `jbd2_log_do_checkpoint`) says where the kernel waits, not which call or
 * file, so four D-state stalls on :3170 on 2026-10-01 (one escalated to a
 * WEDGE SIGKILL) could not be traced to code. The main thread's syscall line
 * can: an fd argument resolves through `/proc/<pid>/fd`, a path argument is a
 * pointer the worker reads from this same process's memory (relative paths are
 * anchored at their dirfd or the cwd). Re-reading the syscall line afterwards
 * drops the result if the thread moved on mid-probe, so the kill record never
 * carries a stale path. Fields: `mainThreadSyscall`, `mainThreadBlockedPath`.
 */
function readMainThreadSyscallWait(): Record<string, string> {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/syscall`, 'utf8');
    const target = parseProcSyscallTarget(raw, process.arch);
    if (!target) return {};
    let path: string | null = null;
    if (target.fd != null) {
      path = readlinkSync(`/proc/${pid}/fd/${target.fd}`);
    } else if (target.pathPtr != null) {
      path = readOwnMemoryPath(target.pathPtr);
      if (path && !path.startsWith('/') && target.dirFd != null) {
        const base = readlinkSync(target.dirFd === AT_FDCWD ? `/proc/${pid}/cwd` : `/proc/${pid}/fd/${target.dirFd}`);
        path = `${base}/${path}`;
      }
    }
    if (readFileSync(`/proc/${pid}/task/${pid}/syscall`, 'utf8') !== raw) return {};
    const out: Record<string, string> = { mainThreadSyscall: target.name };
    if (path) out.mainThreadBlockedPath = path.slice(0, 240);
    return out;
  } catch {
    return {}; // transient syscall/fd race, non-Linux, or unreadable procfs
  }
}

/**
 * What the main thread is doing when it did not answer an inspector request
 * within its timeout. Unlike the STALLED report this does not require state
 * D: an interruptible wait (state S) inside a synchronous syscall also blocks
 * the inspector, and readMainThreadSyscallWait() itself drops a stale read.
 */
function describeUnansweredMainThread(): Record<string, string> {
  const out: Record<string, string> = {};
  const state = readMainThreadStat()?.state;
  if (state) out.mainThreadState = state;
  const wchan = readMainThreadWchan();
  if (wchan) out.mainThreadWchan = wchan;
  return Object.assign(out, readMainThreadSyscallWait());
}

/**
 * Name the main thread's live children, for the synchronous-subprocess case.
 *
 * When the loop is suspended inside `execSync`/`spawnSync` there IS a child,
 * and it is THE culprit — so naming it turns an otherwise unattributable
 * "WEDGED" into the actual offending command. This is the piece that was
 * missing: `wchan: ep_poll` alone reads as "idle" and sent two investigations
 * back to the start (WI-2143536).
 *
 * Per-THREAD children (`/task/<pid>/children`), matching the per-thread stat
 * read above: a process-wide list would include every worker's children and
 * name innocent bystanders. Bounded and best-effort — a diagnostic must never
 * take down the sentinel.
 */
function readMainThreadChildren(limit = 4): string[] {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    if (!raw) return [];
    return raw
      .split(/\s+/)
      .slice(0, limit)
      .map((childPid) => {
        try {
          const cmd = readFileSync(`/proc/${childPid}/cmdline`, 'utf8')
            .replace(/\0+$/, '')
            .split('\0')
            .join(' ')
            .trim();
          return `${cmd.slice(0, 120) || 'unknown'} (pid ${childPid})`;
        } catch {
          return `gone (pid ${childPid})`;
        }
      });
  } catch {
    return []; // not Linux, or no children — absent, never a claim of "none".
  }
}

/** CPU + scheduler state of the main thread at the last observation it was HEALTHY. */
let healthyCpu: { ticks: number; atMs: number } | null = null;

/**
 * Difference the last healthy CPU reading against now, yielding the verdict for
 * the stall window. Best-effort: every field degrades to `unknown`/absent rather
 * than throwing, because a diagnostic must never take down the sentinel.
 */
interface MainThreadActivitySnapshot extends MainThreadActivity {
  fields: Record<string, string | number | boolean>;
}

function mainThreadActivity(): MainThreadActivitySnapshot {
  const now = readMainThreadStat();
  const verdict = classifyThreadCpu({
    baselineTicks: healthyCpu?.ticks ?? null,
    currentTicks: now?.ticks ?? null,
    elapsedMs: healthyCpu ? Date.now() - healthyCpu.atMs : 0,
  });
  const wchan = readMainThreadWchan();
  const cpuPsiSome60 = readCpuPressureSomeAvg60();
  const out: Record<string, string | number | boolean> = {
    mainThreadActivity: verdict.kind,
    mainThreadState: now?.state ?? 'unknown',
  };
  if (verdict.cpuMs != null) out.mainThreadCpuMsDuringStall = Math.round(verdict.cpuMs);
  if (verdict.cores != null) out.mainThreadCores = Number(verdict.cores.toFixed(2));
  if (verdict.suspectWrongSubject) out.suspectWrongSubject = true;
  if (wchan) out.mainThreadWchan = wchan;
  if (cpuPsiSome60 != null) out.mainThreadCpuPsiSome60 = cpuPsiSome60;
  Object.assign(out, readMainThreadDirectoryWait(wchan));
  if (now?.state === 'D') Object.assign(out, readMainThreadSyscallWait());
  const activity: MainThreadActivity = {
    cpuKind: verdict.kind,
    state: now?.state ?? null,
    cpuMs: verdict.cpuMs,
    cores: verdict.cores,
    wchan,
    cpuPsiSome60,
  };
  // Every caller has already established a stale heartbeat. Capture children
  // even when the CPU sample is partial or wchan changes between observations:
  // those were the only surviving clues after the 2026-09-26 staging host kill.
  // The stricter classifier below names the likely block mode, never the child.
  const children = readMainThreadChildren();
  if (children.length) out.mainThreadLiveChildren = children.join(' | ');
  // Complete the PARKED branch. `parked` + `ep_poll` is where an idle loop also
  // sits, so the bare label reads as "healthy" — but an idle loop still runs
  // its timers. Report the mode without suppressing the kill.
  if (isLikelySyncSubprocessBlock(activity)) {
    out.mainThreadBlockMode = 'sync-subprocess-suspected';
  }
  return { ...activity, fields: out };
}

/**
 * IN-STALL CPU PROFILE (WI-10004766, WI-10003454) — which CODE a spinning main
 * thread was running.
 *
 * `mainThreadActivity()` says a stall is `spinning`; nothing said what was
 * spinning, so every R-state stall ended as "cause unknown". The lag monitor's
 * profiler cannot help: it runs ON the main thread and cannot start during the
 * stall it would need to see. This thread can. An inspector Session opened here
 * with `connectToMainThread()` has its messages serviced by the BLOCKED main
 * thread through V8 interrupts. Measured 2026-10-01 (node 25.9): `Profiler.start`
 * answered 95-183 ms after asking, mid-block, for a named JS spin, an 18 s
 * catastrophic regex, and a JSON.stringify loop, and the hot frame was named in
 * all three. Inspector interrupts can also answer during a native futex wait
 * (WI-10005529), so an inspector reply is not proof the loop turns. For parked
 * threads, evaluate a Promise resolved by a main-loop setImmediate and bound
 * its reply too. Neither result changes the kill policy.
 *
 * Fire-and-forget from the observe tick: the capture's awaits run on this
 * worker's own loop and never delay an observation, and a failure only logs.
 * Gotcha (measured): a pending inspector reply does NOT keep a worker alive;
 * the observe `setInterval` below is what does.
 */
const stallProfile: StallProfileConfig | null = data.stallProfile ?? null;
let stallProfileInFlight = false;
let stallProfiledThisStall = false;
let lastStallProfileAtMs: number | null = null;
/** Echoed on the STALLED / WEDGED lines so a reader knows a profile line exists. */
let stallProfileState: 'capturing' | 'captured' | 'failed' | 'discarded' | null = null;
let mainThreadInspectorResponse: 'pending' | 'responsive' | 'not-answered' | 'error' | null = null;
let mainThreadInspectorResponseMs: number | null = null;
let mainThreadEventLoopResponse: 'pending' | 'responsive' | 'not-answered' | 'error' | null = null;
let mainThreadEventLoopResponseMs: number | null = null;

function stallProfileField(): Record<string, string | number> {
  return {
    ...(stallProfileState ? { stallProfile: stallProfileState } : {}),
    ...(mainThreadInspectorResponse ? { mainThreadInspectorResponse } : {}),
    ...(mainThreadInspectorResponseMs != null ? { mainThreadInspectorResponseMs } : {}),
    ...(mainThreadEventLoopResponse ? { mainThreadEventLoopResponse } : {}),
    ...(mainThreadEventLoopResponseMs != null ? { mainThreadEventLoopResponseMs } : {}),
  };
}

function inspectorPost(
  session: Session,
  method: string,
  timeoutMs: number,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return new Promise((resolvePost, rejectPost) => {
    const timer = setTimeout(
      () => rejectPost(new Error(`${method} not answered within ${timeoutMs}ms`)),
      timeoutMs,
    );
    session.post(method, params, (err, result) => {
      clearTimeout(timer);
      if (err) rejectPost(err);
      else resolvePost(result);
    });
  });
}

/** Keep the newest `retain` stall profiles. Only `stall-*.cpuprofile` is touched. */
function pruneStallProfiles(dir: string, retain: number): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('stall-') && f.endsWith('.cpuprofile'))
      .sort();
    for (let i = 0; i < files.length - Math.max(0, retain); i++) {
      rmSync(join(dir, files[i]), { force: true });
    }
  } catch {
    /* retention is best-effort */
  }
}

async function captureStallProfile(
  cfg: StallProfileConfig,
  stalenessAtStartMs: number,
  cpuKind: string,
): Promise<void> {
  const startedAtMs = Date.now();
  const beatAtStart = Atomics.load(view, 0);
  let session: Session | null = null;
  let profilerStarted = false;
  try {
    session = new Session();
    session.connectToMainThread();
    await inspectorPost(session, 'Profiler.enable', 3_000);
    mainThreadInspectorResponse = 'responsive';
    mainThreadInspectorResponseMs = Date.now() - startedAtMs;
    const discardRecoveredCapture = (): boolean => {
      if (Atomics.load(view, 0) === beatAtStart) return false;
      stallProfileState = 'discarded';
      emit('STALL profile discarded — heartbeat recovered before profiler start', {
        pid,
        stalenessAtStartMs,
        mainThreadActivity: cpuKind,
        ...stallProfileField(),
      });
      return true;
    };
    if (discardRecoveredCapture()) return;
    if (cpuKind === 'parked') {
      mainThreadEventLoopResponse = 'pending';
      const probeStartedAtMs = Date.now();
      const response = await inspectorPost(session, 'Runtime.evaluate', 3_000, {
        expression: "new Promise(resolve => setImmediate(() => resolve('event-loop-responsive')))",
        awaitPromise: true,
        returnByValue: true,
      }) as { result?: { value?: unknown } };
      if (response.result?.value !== 'event-loop-responsive') {
        throw new Error('main event-loop callback probe returned no responsiveness proof');
      }
      mainThreadEventLoopResponse = 'responsive';
      mainThreadEventLoopResponseMs = Date.now() - probeStartedAtMs;
      if (discardRecoveredCapture()) return;
    }
    emit('main thread inspector answered during stale heartbeat', {
      pid,
      stalenessAtStartMs,
      mainThreadActivity: cpuKind,
      ...stallProfileField(),
    });
    // Not a responsiveness probe: start cost scales with heap/code size
    // (STALL_PROFILE_DEFAULTS.startTimeoutMs). A late start is still useful
    // while the stall lasts; discardRecoveredCapture() drops it if not.
    await inspectorPost(session, 'Profiler.start', cfg.startTimeoutMs ?? STALL_PROFILE_DEFAULTS.startTimeoutMs);
    profilerStarted = true;
    if (discardRecoveredCapture()) return;
    await new Promise((r) => setTimeout(r, cfg.captureMs));
    const stopped = (await inspectorPost(session, 'Profiler.stop', 5_000)) as {
      profile: CpuProfileLike;
    };
    profilerStarted = false;
    // The heartbeat moving means the loop turned again mid-capture, so the
    // tail of the profile is post-stall activity rather than the stall.
    const stallEndedDuringCapture = Atomics.load(view, 0) !== beatAtStart;
    mkdirSync(cfg.dir, { recursive: true });
    pruneStallProfiles(cfg.dir, cfg.maxProfiles - 1);
    const file = join(cfg.dir, `stall-${startedAtMs}-pid${pid}.cpuprofile`);
    // Write-then-rename: a partial file must never look like a loadable profile.
    writeFileSync(`${file}.tmp`, JSON.stringify(stopped.profile));
    renameSync(`${file}.tmp`, file);
    stallProfileState = 'captured';
    const summary = summarizeHotStacks(stopped.profile, { top: 3, depth: 6 });
    const spawn = syncSpawnProducer(summary);
    emit('main event loop STALL profiled — hot stacks of the blocked main thread', {
      pid,
      stalenessAtStartMs,
      captureMs: cfg.captureMs,
      mainThreadActivity: cpuKind,
      ...stallProfileField(),
      stallEndedDuringCapture,
      file,
      ...hotStackFields(summary),
      ...(spawn ? { syncSpawnProducer: spawn.producer } : {}),
    });
    // WI-10005253: hand a sync child-process producer to the main thread, which files it once its
    // loop turns again (event-loop-sync-spawn-report.ts). The worker itself has no DB access.
    if (spawn) {
      parentPort?.postMessage({
        kind: 'sync-spawn-stall',
        pid,
        file,
        stalenessAtStartMs,
        mainThreadActivity: cpuKind,
        ...spawn,
      });
    }
  } catch (err) {
    stallProfileState = 'failed';
    if (mainThreadInspectorResponse === 'pending') {
      mainThreadInspectorResponse = String(err).includes('not answered within') ? 'not-answered' : 'error';
    }
    if (mainThreadEventLoopResponse === 'pending') {
      mainThreadEventLoopResponse = String(err).includes('not answered within') ? 'not-answered' : 'error';
    }
    // An inspector request the main thread never answered means it is inside
    // native code (usually a synchronous syscall), so no profile can exist.
    // Name the call and file instead; otherwise this stall stays unattributed
    // (WI-10006344: 2 of 4 stalls after the start-timeout fix).
    const blockedIn =
      mainThreadInspectorResponse === 'not-answered' || mainThreadEventLoopResponse === 'not-answered'
        ? describeUnansweredMainThread()
        : {};
    emit('STALL profile capture failed — sentinel unaffected', {
      pid,
      stalenessAtStartMs,
      mainThreadActivity: cpuKind,
      ...stallProfileField(),
      ...blockedIn,
      error: String(err).slice(0, 200),
    });
  } finally {
    if (session && profilerStarted) {
      // Recovery after Profiler.start must not leave V8 sampling this host.
      try { await inspectorPost(session, 'Profiler.stop', 1_000); } catch { /* best effort */ }
    }
    try {
      // Also discards a profile whose start was queued behind a syscall and
      // answered only after the timeout: the session's profiler dies with it.
      session?.disconnect();
    } catch {
      /* ignore */
    }
    stallProfileInFlight = false;
  }
}

/**
 * Called on every observation with the current staleness (0 during the startup
 * grace, so boot's legitimate synchronous work is never profiled). Below the
 * threshold it re-arms for the next stall; at or past it, it captures once per
 * stall when `shouldCaptureStallProfile` agrees. Must run BEFORE the 'ok' branch
 * re-baselines `healthyCpu`, so the CPU verdict covers the stale window.
 */
function maybeStartStallProfile(stalenessMs: number): void {
  if (!stallProfile) return;
  if (stalenessMs < stallProfile.afterMs) {
    stallProfiledThisStall = false;
    if (!stallProfileInFlight) {
      stallProfileState = null;
      mainThreadInspectorResponse = null;
      mainThreadInspectorResponseMs = null;
      mainThreadEventLoopResponse = null;
      mainThreadEventLoopResponseMs = null;
    }
    return;
  }
  if (stallProfileInFlight || stallProfiledThisStall) return;
  try {
    const now = readMainThreadStat();
    const cpuKind = classifyThreadCpu({
      baselineTicks: healthyCpu?.ticks ?? null,
      currentTicks: now?.ticks ?? null,
      elapsedMs: healthyCpu ? Date.now() - healthyCpu.atMs : 0,
    }).kind;
    const nowMs = Date.now();
    if (
      !shouldCaptureStallProfile(
        {
          stalenessMs,
          cpuKind,
          capturedThisStall: stallProfiledThisStall,
          inFlight: stallProfileInFlight,
          lastCaptureAtMs: lastStallProfileAtMs,
          nowMs,
        },
        stallProfile,
      )
    ) {
      return;
    }
    stallProfileInFlight = true;
    stallProfiledThisStall = true;
    lastStallProfileAtMs = nowMs;
    stallProfileState = 'capturing';
    mainThreadInspectorResponse = 'pending';
    mainThreadInspectorResponseMs = null;
    mainThreadEventLoopResponse = null;
    mainThreadEventLoopResponseMs = null;
    void captureStallProfile(stallProfile, stalenessMs, cpuKind);
  } catch (err) {
    // A diagnostic must never take down the sentinel.
    stallProfileInFlight = false;
    emit('STALL profile trigger threw — sentinel unaffected', {
      error: String(err).slice(0, 200),
    });
  }
}

let state: LoopSentinelState = initialLoopSentinelState(
  Date.now(),
  Atomics.load(view, 0),
);
/** Warn at most once per contiguous stall, so a long wedge is not a log flood. */
let warnedThisStall = false;
/** Observe-mode: report a WEDGE at most once per contiguous stall (same reason). */
let reportedThisStall = false;
/** Host-I/O suppression is also one log per contiguous stall. */
let hostIoWaitReportedThisStall = false;
/** Host-CPU suppression is also one log per contiguous stall. */
let cpuStarvationReportedThisStall = false;
let acted = false;

const timer = setInterval(() => {
  if (acted) return;
  let decision;
  try {
    decision = decideLoopSentinelAction(
      state,
      { counter: Atomics.load(view, 0), nowMs: Date.now() },
      thresholds,
    );
  } catch (err) {
    // A decider throw must never kill the host, and must never spin silently.
    emit('decider threw — sentinel disabling itself (host unaffected)', {
      error: String(err).slice(0, 200),
    });
    acted = true;
    clearInterval(timer);
    return;
  }

  state = decision.state;
  const action = decision.action;

  switch (action.kind) {
    case 'ok':
    case 'grace': {
      // A stale-but-sub-warn 'ok' is where the profile starts (~4-6 s into a
      // stall); grace passes 0 so boot is never profiled. Before re-baselining.
      maybeStartStallProfile(action.kind === 'ok' ? action.stalenessMs : 0);
      // The loop is turning again — re-arm both one-per-stall latches so the
      // NEXT stall is reported as a fresh event rather than suppressed.
      warnedThisStall = false;
      reportedThisStall = false;
      hostIoWaitReportedThisStall = false;
      cpuStarvationReportedThisStall = false;
      // Re-baseline the CPU reading while the loop is demonstrably healthy, so a
      // later stall differences against the last GOOD sample. Taken here rather
      // than at stall-detection time because by then the window has already
      // started and its beginning is exactly what we would be missing.
      const healthy = readMainThreadStat();
      if (healthy) healthyCpu = { ticks: healthy.ticks, atMs: Date.now() };
      return;
    }

    case 'warn':
      maybeStartStallProfile(action.stalenessMs);
      if (!warnedThisStall) {
        warnedThisStall = true;
        emit('main event loop STALLED (not yet actionable)', {
          stalenessMs: action.stalenessMs,
          wedgeAfterMs: thresholds.wedgeAfterMs,
          consecutiveStale: action.consecutiveStale,
          ...mainThreadActivity().fields,
          ...lastKnownLag(),
          ...stallProfileField(),
        });
      }
      return;

    case 'escalate-never-started':
      // The heartbeat has never moved. Cannot distinguish a loop wedged before
      // we started from a heartbeat that was never armed, so we must NOT kill —
      // that would turn a bug in this module into a host boot loop. The
      // out-of-process probe (dev:service_health, which reads unaccepted
      // connections off the LISTEN socket) owns never-started.
      acted = true;
      clearInterval(timer);
      emit(
        'heartbeat NEVER observed — NOT killing. Either the loop wedged before the sentinel started, or the heartbeat was never armed; these are indistinguishable from here. Check dev:service_health for an accept-queue wedge.',
        {
          stalenessMs: action.stalenessMs,
          consecutiveStale: action.consecutiveStale,
          pid,
          ...lastKnownLag(),
        },
      );
      return;

    case 'kill': {
      const activity = mainThreadActivity();

      // A stale heartbeat plus a main thread in D-state, with zero CPU and a
      // recognized storage wait channel, means the host is blocked behind I/O.
      // SIGKILL cannot free the block and a restart adds more I/O pressure, so
      // keep watching instead. If the thread later becomes a CPU-consuming
      // wedge, a subsequent observation still reaches the normal kill path.
      if (isConfirmedHostIoWait(activity)) {
        if (hostIoWaitReportedThisStall) return;
        hostIoWaitReportedThisStall = true;
        emit('main event loop WEDGED — host I/O wait, NOT killing', {
          stalenessMs: action.stalenessMs,
          consecutiveStale: action.consecutiveStale,
          wedgeAfterMs: thresholds.wedgeAfterMs,
          mode,
          pid,
          reason: 'main thread is in confirmed uninterruptible storage wait; continue watching without restarting the host',
          hostIoWait: true,
          ...activity.fields,
          ...lastKnownLag(),
        });
        return;
      }

      // A runnable main thread consuming a real core while the host's PSI says
      // runnable work is critically starved is an ambient CPU incident, not a
      // self-contained event-loop wedge. Restarting here feeds the same CPU
      // pressure and can create a self-sustaining restart loop. Unknown or
      // sub-critical PSI intentionally falls through to the normal kill path.
      if (isConfirmedCpuStarvation(activity)) {
        if (cpuStarvationReportedThisStall) return;
        cpuStarvationReportedThisStall = true;
        emit('main event loop WEDGED — host CPU starvation, NOT killing', {
          stalenessMs: action.stalenessMs,
          consecutiveStale: action.consecutiveStale,
          wedgeAfterMs: thresholds.wedgeAfterMs,
          mode,
          pid,
          reason: 'main thread is spinning while CPU PSI reports critical runnable-task starvation; continue watching without restarting the host',
          hostCpuStarvation: true,
          ...activity.fields,
          ...lastKnownLag(),
        });
        return;
      }

      // KILL mode is one-shot (the process is about to die). OBSERVE mode must
      // KEEP WATCHING — it exists to soak a suspect host, and a one-shot
      // observer reports exactly one wedge per host lifetime, which is useless
      // for "does this recur, and how often". Guard the flood instead: report
      // once per contiguous stall, and re-arm only after the loop RECOVERS
      // (the 'ok'/'grace' branches clear `reportedThisStall`).
      if (mode === 'kill') {
        acted = true;
        clearInterval(timer);
      } else {
        if (reportedThisStall) return;
        reportedThisStall = true;
      }
      emit(
        mode === 'kill'
          ? 'main event loop WEDGED — SIGKILLing the host (systemd will restart it)'
          : 'main event loop WEDGED — observe mode, NOT killing',
        {
          stalenessMs: action.stalenessMs,
          consecutiveStale: action.consecutiveStale,
          wedgeAfterMs: thresholds.wedgeAfterMs,
          mode,
          pid,
          reason: action.reason,
          ...activity.fields,
          ...lastKnownLag(),
          ...stallProfileField(),
        },
      );
      if (mode === 'kill') {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (err) {
          emit('SIGKILL failed — host left running', {
            error: String(err).slice(0, 200),
            pid,
          });
        }
      }
      return;
    }
  }
}, observeIntervalMs);

// ⚠ DO NOT `timer.unref()` HERE. This interval is the worker's ONLY handle, so
// unref-ing it leaves the worker's event loop with nothing to wait on and the
// THREAD EXITS — cleanly, with code 0, immediately after the `ready` message
// below. Measured 2026-08-04: the worker reported ready, exited 0, and detected
// nothing; the host still logged "armed" and reported active, because from the
// parent's side a spawned-then-exited worker looks identical to a running one
// until you listen for 'exit'. That is a silent total failure of the sentinel.
//
// "Don't hold the process open" is a real requirement, but it belongs on the
// PARENT side: `worker.unref()` in event-loop-sentinel-host.ts tells the main
// thread not to count this worker as a reason to stay alive, while leaving the
// worker itself internally alive. Keep the two straight.
parentPort?.postMessage({ kind: 'ready' });
