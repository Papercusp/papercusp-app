/**
 * proc-thread-cpu.ts — parse `/proc/<pid>/stat` CPU ticks, and turn two samples
 * into a verdict about what a thread was DOING between them.
 *
 * ## Why this is its own module
 *
 * Two callers need the same parse and must not fork it:
 *
 * - `test-desktop-reaper.ts` (identifies runaway desktop processes), and
 * - `event-loop-sentinel.worker.ts`, which runs on a `worker_threads` Worker and
 *   is a **worker ENTRY**. Worker threads do not inherit the parent's ESM loader
 *   hooks, so that file is loaded by Node's native type stripping. It therefore
 *   cannot import anything that needs a real transform or drags in dependencies
 *   — the reaper imports `drizzle-orm` and `sync-sse`, so importing it from the
 *   worker would break the sentinel. Everything here is dependency-free and
 *   syntax-plain on purpose. Keep it that way.
 *
 * ## The distinction this exists to preserve
 *
 * `/proc/<pid>/stat` reports the CPU of the WHOLE PROCESS (all threads summed).
 * `/proc/<pid>/task/<tid>/stat` reports ONE thread. Reading the first while
 * believing the second is the standard way to conclude "the main thread is
 * busy" about a process whose main thread is parked and whose children are
 * burning CPU — the same class of error as measuring a supervisor pid and
 * calling the tree idle. `classifyThreadCpu` flags that case rather than
 * quietly reporting a number that cannot be true of a single thread.
 */

/**
 * Linux USER_HZ — clock ticks/sec for /proc utime+stime. 100 on every mainstream
 * build (CONFIG_HZ_100 default). A wrong value only scales the derived cpuMs, so
 * a hardcode is safe; it never changes which branch a caller takes on identity.
 */
export const USER_HZ = 100;

/** Linux CPU PSI `some avg60` level at which host starvation is critical. */
export const CPU_PSI_CRITICAL_AVG60 = 85;

/** One parsed `/proc/<pid>/stat` (or `/proc/<pid>/task/<tid>/stat`) reading. */
export interface ProcStatSample {
  /** Scheduler state letter: R runnable, S sleeping, D uninterruptible, Z zombie. */
  state: string;
  /** utime + stime, in clock ticks (see USER_HZ). */
  ticks: number;
}

/**
 * Parse the CPU fields out of a raw `/proc/**\/stat` line.
 *
 * `comm` (field 2) is parenthesised and may itself contain spaces AND parens
 * (`(node (worker))`), so a naive whitespace split mis-indexes every later
 * field. Splitting after the LAST ')' is the only correct approach.
 * Post-')' tokens: `[0]=state … [11]=utime [12]=stime`.
 *
 * Returns null on anything unparseable — callers treat that as "unknown", never
 * as zero, because a zero here reads as "idle" and is the wrong default.
 */
export function parseProcStat(raw: string): ProcStatSample | null {
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const rest = raw.slice(close + 1).trim().split(/\s+/);
  if (rest.length < 13) return null;
  const state = rest[0];
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { state, ticks: utime + stime };
}

/**
 * Parse the directory file descriptor from a Linux `/proc/<tid>/syscall` line
 * while that thread is parked in `iterate_dir`.
 *
 * `/proc/<tid>/syscall` is `syscall-number arg0 arg1 ...`; `getdents64`'s arg0
 * is the directory fd. The syscall number is deliberately NOT checked because
 * it is architecture-specific. The wait channel is the portable discriminator
 * that tells us this syscall's first argument has directory-fd semantics.
 *
 * Linux renders arguments as either decimal or `0x`-prefixed integers, both of
 * which `Number` accepts. Anything else is UNKNOWN, never fd 0: this diagnostic
 * runs immediately before a possible SIGKILL, so a plausible-looking wrong
 * directory is worse than an omitted field.
 */
export function parseProcDirectoryFd(raw: string, wchan: string | null): number | null {
  if (wchan?.trim() !== 'iterate_dir') return null;
  const fields = raw.trim().split(/\s+/);
  if (fields.length < 2 || fields[0] === 'running') return null;
  const fd = Number(fields[1]);
  return Number.isSafeInteger(fd) && fd >= 0 ? fd : null;
}

/** `AT_FDCWD` — the dirfd value meaning "relative to the cwd" for `*at` syscalls. */
export const AT_FDCWD = -100;

/**
 * x86-64 syscalls whose blocking on the main thread names a FILE, keyed by
 * number. `fd` = arg0 is an open file descriptor; `path0` = arg0 is a path
 * pointer; `at` = arg0 is a dirfd and arg1 a path pointer.
 *
 * Deliberately x86-64 only: syscall numbers are architecture-specific, and a
 * wrong table would name a plausible but wrong file in the record written just
 * before a possible SIGKILL. On any other arch the parser returns `null`.
 */
const X64_FILE_SYSCALLS: Readonly<Record<number, readonly [string, 'fd' | 'path0' | 'at']>> = {
  0: ['read', 'fd'], 1: ['write', 'fd'], 2: ['open', 'path0'], 3: ['close', 'fd'],
  4: ['stat', 'path0'], 5: ['fstat', 'fd'], 6: ['lstat', 'path0'], 16: ['ioctl', 'fd'],
  17: ['pread64', 'fd'], 18: ['pwrite64', 'fd'], 19: ['readv', 'fd'], 20: ['writev', 'fd'],
  21: ['access', 'path0'], 73: ['flock', 'fd'], 74: ['fsync', 'fd'], 75: ['fdatasync', 'fd'],
  76: ['truncate', 'path0'], 77: ['ftruncate', 'fd'], 78: ['getdents', 'fd'],
  82: ['rename', 'path0'], 83: ['mkdir', 'path0'], 84: ['rmdir', 'path0'], 85: ['creat', 'path0'],
  86: ['link', 'path0'], 87: ['unlink', 'path0'], 89: ['readlink', 'path0'], 90: ['chmod', 'path0'],
  91: ['fchmod', 'fd'], 92: ['chown', 'path0'], 93: ['fchown', 'fd'], 94: ['lchown', 'path0'],
  137: ['statfs', 'path0'], 138: ['fstatfs', 'fd'], 217: ['getdents64', 'fd'],
  257: ['openat', 'at'], 258: ['mkdirat', 'at'], 260: ['fchownat', 'at'], 262: ['newfstatat', 'at'],
  263: ['unlinkat', 'at'], 264: ['renameat', 'at'], 265: ['linkat', 'at'], 267: ['readlinkat', 'at'],
  268: ['fchmodat', 'at'], 269: ['faccessat', 'at'], 277: ['sync_file_range', 'fd'],
  280: ['utimensat', 'at'], 285: ['fallocate', 'fd'], 295: ['preadv', 'fd'], 296: ['pwritev', 'fd'],
  306: ['syncfs', 'fd'], 316: ['renameat2', 'at'], 327: ['preadv2', 'fd'], 328: ['pwritev2', 'fd'],
  332: ['statx', 'at'], 437: ['openat2', 'at'], 439: ['faccessat2', 'at'], 452: ['fchmodat2', 'at'],
};

/** What a thread blocked in a file syscall is touching, from `/proc/<tid>/syscall`. */
export interface ProcSyscallTarget {
  /** Syscall number as the kernel reported it. */
  nr: number;
  /** Syscall name (x86-64 table). */
  name: string;
  /** Open fd to resolve through `/proc/<pid>/fd/<fd>` (fd syscalls). */
  fd?: number;
  /** User-space address of the NUL-terminated path argument (path syscalls). */
  pathPtr?: number;
  /** Base dirfd for a RELATIVE path of an `*at` syscall; {@link AT_FDCWD} = cwd. */
  dirFd?: number;
}

/** One `/proc/<tid>/syscall` argument as a signed 32-bit int (fds and dirfds are C `int`). */
function procArgInt32(field: string | undefined): number | null {
  if (!field || !/^(0x[0-9a-f]+|[0-9]+)$/i.test(field)) return null;
  return Number(BigInt.asIntN(32, BigInt(field)));
}

/** One `/proc/<tid>/syscall` argument as a user-space pointer; null when not a safe integer. */
function procArgPointer(field: string | undefined): number | null {
  if (!field || !/^(0x[0-9a-f]+|[0-9]+)$/i.test(field)) return null;
  const v = BigInt(field);
  return v > 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}

/**
 * Parse which FILE a thread is blocked on from its `/proc/<tid>/syscall` line
 * (`nr arg0 arg1 … sp pc`), for a main thread parked in D-state (WI-10004754).
 *
 * The wait channel says WHERE in the kernel the thread waits (`lookup_slow`,
 * `jbd2_log_do_checkpoint`, …) but not which call or file, so a D-state stall
 * could not be traced back to code. The syscall line can: an fd argument
 * resolves through `/proc/<pid>/fd`, and a path argument is a pointer into the
 * process's own memory, which the in-process sentinel worker can read.
 *
 * Returns null for `running`, for "blocked but not in a syscall" (`-1 …`),
 * for an unknown or non-file syscall, for a malformed argument, and on any arch
 * other than x64. UNKNOWN is never coerced to fd 0 or a guessed path.
 */
export function parseProcSyscallTarget(raw: string, arch: string): ProcSyscallTarget | null {
  if (arch !== 'x64') return null;
  const fields = raw.trim().split(/\s+/);
  if (fields.length < 3 || !/^[0-9]+$/.test(fields[0])) return null;
  const nr = Number(fields[0]);
  const entry = X64_FILE_SYSCALLS[nr];
  if (!entry) return null;
  const [name, shape] = entry;
  if (shape === 'fd') {
    const fd = procArgInt32(fields[1]);
    return fd != null && fd >= 0 ? { nr, name, fd } : null;
  }
  if (shape === 'path0') {
    const pathPtr = procArgPointer(fields[1]);
    return pathPtr != null ? { nr, name, pathPtr } : null;
  }
  const dirFd = procArgInt32(fields[1]);
  const pathPtr = procArgPointer(fields[2]);
  if (dirFd == null || pathPtr == null || (dirFd < 0 && dirFd !== AT_FDCWD)) return null;
  return { nr, name, pathPtr, dirFd };
}

/**
 * Decode a NUL-terminated path read out of process memory. Null when the bytes
 * hold no NUL (a truncated read) or decode to nothing; never a partial guess.
 */
export function decodeProcPath(bytes: Uint8Array, length: number): string | null {
  const end = bytes.subarray(0, Math.max(0, Math.min(length, bytes.length))).indexOf(0);
  if (end <= 0) return null;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * Parse the CPU-pressure `some avg60` percentage from `/proc/pressure/cpu`.
 *
 * PSI is a percentage of wall time in which at least one runnable task waited
 * for CPU. Missing, malformed, or out-of-range values are UNKNOWN (`null`),
 * never zero: the sentinel must not turn an unreadable pressure file into a
 * reason to suppress a real wedge kill.
 */
export function parseCpuPressureSomeAvg60(raw: string): number | null {
  const line = raw.split('\n').find((candidate) => /^\s*some\s/.test(candidate));
  if (!line) return null;
  const value = Number(/\bavg60=([0-9]+(?:\.[0-9]+)?)(?:\s|$)/.exec(line)?.[1] ?? NaN);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/**
 * What a thread was doing across a sampling window.
 *
 * - `spinning`  — burning CPU. For a blocked event loop this means a synchronous
 *                 JS loop / GC, and a stack sample is the next step.
 * - `parked`    — using ~no CPU. Blocked in a syscall or simply not scheduled;
 *                 `state` (D vs S) and wchan discriminate further.
 * - `partial`   — in between; neither explanation is clean.
 * - `unknown`   — could not be measured. NOT the same as parked, and must never
 *                 be rendered as 0.
 */
export type ThreadCpuKind = 'spinning' | 'parked' | 'partial' | 'unknown';

export interface ThreadCpuVerdict {
  kind: ThreadCpuKind;
  /** CPU consumed across the window, in ms. Null when unknown. */
  cpuMs: number | null;
  /** cpuMs / elapsedMs — "cores' worth". Null when unknown. */
  cores: number | null;
  /**
   * True when `cores` exceeds what one thread can possibly use, which means the
   * sample almost certainly came from a PROCESS-wide stat file rather than a
   * per-thread one. Surfaced instead of swallowed: the number is not wrong so
   * much as about the wrong subject, and that is the misreading that costs
   * hours.
   */
  suspectWrongSubject: boolean;
}

/**
 * A main-thread activity sample as reported by the event-loop sentinel.
 *
 * This stays dependency-free because the sentinel worker is loaded by plain
 * Node's native type stripping. Keeping the safety decision beside the CPU
 * classifier prevents the worker and its tests from drifting in how they
 * interpret `/proc`.
 */
export interface MainThreadActivity {
  /** CPU verdict produced by `classifyThreadCpu` for this sample window. */
  cpuKind?: ThreadCpuKind;
  state: string | null;
  cpuMs: number | null;
  cores: number | null;
  wchan: string | null;
  /** Host CPU PSI `some avg60`, or null when the pressure read was unknown. */
  cpuPsiSome60?: number | null;
}

/**
 * Linux wait-channel names that identify a thread parked behind block I/O.
 *
 * The exact-zero CPU and D-state checks are load-bearing: a name alone is not
 * enough to establish that the main thread is the parked subject rather than
 * a stale or misread `/proc` sample.
 */
const HOST_IO_WAIT_WCHAN_RE = /^(?:iterate_dir|rq_qos_wait|io_schedule(?:_timeout)?|blk_mq_[a-z0-9_]+|wait_on_(?:buffer|page(?:_bit)?|page_writeback)|folio_wait_[a-z0-9_]+|(?:__)?jbd2_[a-z0-9_]+|do_get_write_access|wait_transaction_locked)$/i;

/**
 * Decide whether a sentinel kill should be suppressed because the main thread
 * is demonstrably waiting on host storage rather than wedged in JavaScript.
 *
 * SIGKILL cannot relieve a block-device queue or swap-thrash wait. Suppressing
 * it keeps the host from adding a restart/materialization storm to the I/O
 * incident while the caller continues watching for recovery or a later
 * transition to a real CPU-consuming wedge.
 */
export function isConfirmedHostIoWait(activity: MainThreadActivity): boolean {
  const wchan = activity.wchan?.trim();
  return (
    activity.state === 'D' &&
    activity.cpuMs === 0 &&
    activity.cores === 0 &&
    Boolean(wchan && HOST_IO_WAIT_WCHAN_RE.test(wchan))
  );
}

/**
 * Wait channels for a thread parked in an event-loop poll (epoll/poll/select).
 *
 * This is where an IDLE loop sits — and also where a loop suspended by a
 * SYNCHRONOUS child-process call sits, because `execSync`/`spawnSync` run a
 * NESTED libuv loop whose `epoll_wait` blocks the outer one.
 */
const LOOP_POLL_WCHAN_RE = /^(?:ep_poll|do_epoll_wait|do_sys_poll|do_select|poll_schedule_timeout)$/i;

/**
 * Is the main thread parked in an event-loop poll while its heartbeat is dead?
 *
 * ## Why this predicate exists (measured, WI-2143536)
 *
 * `papercusp-bg-host` was SIGKILLed 12 times in 37 minutes, every kill
 * reporting `mainThreadCpuMsDuringStall: 0, mainThreadWchan: ep_poll,
 * mainThreadState: S`. Two separate investigations read that as a HEALTHY IDLE
 * host and concluded the WEDGED verdict was false. Both were wrong, and the
 * "obvious" fix they each reached for — letting this evidence veto the kill —
 * would have converted a self-restarting host into a permanently dead one.
 *
 * The signature was reproduced exactly by a 6-second `execSync`: wchan
 * `ep_poll`, state `S`, utime/stime frozen, and ZERO fires of a 500 ms
 * `setInterval` for the whole call. So this reading does not mean "idle" — it
 * means the loop is suspended inside a nested libuv loop, i.e. blocked on a
 * synchronous subprocess (or another sync native binding).
 *
 * ## Why "heartbeat is dead" is a REQUIRED input and not inferred here
 *
 * An idle loop and a `spawnSync`-blocked loop are INDISTINGUISHABLE in
 * `/proc` — identical state, wchan and CPU. The only thing that separates them
 * is that an idle loop still runs its timers. This predicate is therefore only
 * meaningful where the caller has already established staleness, which is why
 * it takes no `/proc` reading alone as sufficient.
 *
 * ⛔ REPORT-ONLY. Unlike `isConfirmedHostIoWait`, this must NEVER suppress a
 * kill. SIGKILL cannot relieve a block-device wait (hence that suppressor), but
 * a host stuck behind a runaway synchronous subprocess genuinely has stopped
 * doing its scheduled work, and restarting it is the correct remedy. This
 * exists to NAME the blocking mode so the next occurrence is diagnosable
 * instead of restarting the investigation from scratch.
 */
export function isLikelySyncSubprocessBlock(activity: MainThreadActivity): boolean {
  const wchan = activity.wchan?.trim();
  return (
    activity.state === 'S' &&
    activity.cpuMs === 0 &&
    activity.cores === 0 &&
    Boolean(wchan && LOOP_POLL_WCHAN_RE.test(wchan))
  );
}

/**
 * Decide whether a spinning main thread is being starved by the host CPU.
 *
 * This is intentionally narrower than "high CPU": a genuine synchronous JS
 * spin must remain killable on a quiet host. Suppression requires the measured
 * per-thread verdict, a runnable main thread, and critical host PSI. Any
 * missing/invalid PSI or impossible multi-core reading falls through to the
 * normal sentinel action.
 */
export function isConfirmedCpuStarvation(
  activity: MainThreadActivity,
  criticalPsi = CPU_PSI_CRITICAL_AVG60,
): boolean {
  const psi = activity.cpuPsiSome60;
  return (
    activity.cpuKind === 'spinning' &&
    activity.state === 'R' &&
    activity.cores != null &&
    activity.cores <= 1.5 &&
    psi != null &&
    Number.isFinite(psi) &&
    Number.isFinite(criticalPsi) &&
    criticalPsi > 0 &&
    psi >= criticalPsi
  );
}

const UNKNOWN: ThreadCpuVerdict = {
  kind: 'unknown',
  cpuMs: null,
  cores: null,
  suspectWrongSubject: false,
};

/**
 * Difference two `parseProcStat` readings of the SAME thread into a verdict.
 *
 * Deliberately pure so every branch is reachable from a test with plain numbers
 * — the same reason `decideLoopSentinelAction` is a pure reducer.
 */
export function classifyThreadCpu(opts: {
  /** ticks at the start of the window; null if it could not be read. */
  baselineTicks: number | null;
  /** ticks at the end of the window; null if it could not be read. */
  currentTicks: number | null;
  /** wall-clock ms between the two samples. */
  elapsedMs: number;
  userHz?: number;
  /** at/above this many cores' worth, call it spinning. */
  spinningCores?: number;
  /** at/below this many cores' worth, call it parked. */
  parkedCores?: number;
}): ThreadCpuVerdict {
  const {
    baselineTicks,
    currentTicks,
    elapsedMs,
    userHz = USER_HZ,
    spinningCores = 0.5,
    parkedCores = 0.05,
  } = opts;

  if (baselineTicks == null || currentTicks == null) return UNKNOWN;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return UNKNOWN;
  if (!(userHz > 0)) return UNKNOWN;

  const deltaTicks = currentTicks - baselineTicks;
  // A negative delta means the counter reset under us — the thread/process was
  // replaced between samples. That is not "0 CPU"; it is no measurement at all.
  if (deltaTicks < 0) return UNKNOWN;

  const cpuMs = (deltaTicks / userHz) * 1000;
  const cores = cpuMs / elapsedMs;
  const suspectWrongSubject = cores > 1.5;

  const kind: ThreadCpuKind =
    cores >= spinningCores ? 'spinning' : cores <= parkedCores ? 'parked' : 'partial';

  return { kind, cpuMs, cores, suspectWrongSubject };
}
