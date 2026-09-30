/**
 * a11y-bus-sweep — reap the a11y session buses whose desktop is already gone.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `startA11yBus` (./a11y-bus) spawns `dbus-daemon --fork` per provisioned
 * desktop. `--fork` means the daemon reparents to init immediately, and its ONLY
 * reaper is `createOwnedDaemonRelease()` — a closure living in the operator's
 * heap. Every way the operator can stop running without unwinding (a restart, a
 * deploy, a crash, an OOM kill) drops that closure and strands the daemon plus
 * the two at-spi children it activates, forever.
 *
 * Measured 2026-08-23: 98 `/tmp/pcv/pc-a11y-*` dirs created between 08:47Z and
 * 19:32Z, 46 of the host's 115 `dbus-daemon` processes were pc-a11y session
 * buses, and one orphaned terminal scope held 14 session-bus leaders all 77h
 * old. The population climbs monotonically with desktop-gate runs and is
 * independent of how many agents are alive — which is exactly why it reads as
 * "the process count keeps rising while the agent count is flat".
 *
 * The build guard does not catch the spawn site: `check-no-unenrolled-detached-spawn`
 * triggers on Node's `detached` option or on a stored child handle, and a child
 * that self-daemonizes with `--fork` presents neither. So the leak needs a
 * reaper of its own rather than a lint fix.
 *
 * ── THE DISCRIMINATOR, AND WHY IT IS NOT AGE ─────────────────────────────────
 * Age alone cannot tell a leaked bus from a long-lived healthy one — a desktop
 * legitimately held for days looks identical to residue. The decisive signal is
 * the DISPLAY the daemon was pinned to at spawn time: `startA11yBus` sets it via
 * `sandboxXEnv(display)` and refuses `:0`, so every bus carries the display it
 * belongs to in its own environment. **An X display that no longer exists cannot
 * acquire a new client**, so a bus whose display is gone is unreachable by
 * definition — no timing assumption required.
 *
 * Age is kept only as a SECOND, independent condition guarding the startup race:
 * a desktop that is mid-provision has spawned its bus but may not yet have its
 * X lock visible. Requiring both means the sweep cannot win that race.
 *
 * Everything here is pure over injected readings so the policy is unit-testable
 * without a desktop, a dbus, or a /proc.
 */

/** Default safety margin below which a bus is never touched, however dead its display looks. */
export const DEFAULT_MIN_AGE_SEC = 6 * 60 * 60;

/** One live `dbus-daemon --fork` started by `startA11yBus`, as read from /proc. */
export interface A11yBusProcess {
  pid: number;
  /** The `/tmp/pcv/pc-a11y-XXXXXX` directory from `--config-file`. */
  confDir: string;
  /** `DISPLAY` from the daemon's own environ — null when it could not be read. */
  display: string | null;
  ageSec: number;
}

export interface SweepPolicy {
  minAgeSec?: number;
  /** Displays currently backed by an X server (e.g. from `/tmp/.X<n>-lock`). */
  liveDisplays: ReadonlySet<string>;
}

export type KeepReason =
  | 'too-young'
  | 'display-live'
  | 'display-unknown';

export interface SweepDecision {
  reap: A11yBusProcess[];
  keep: { proc: A11yBusProcess; reason: KeepReason }[];
}

/**
 * Decide which buses are provably unreachable.
 *
 * A bus is reaped only when BOTH hold:
 *   1. its display is known AND absent from `liveDisplays`, and
 *   2. it is older than `minAgeSec`.
 *
 * An UNKNOWN display is never reaped. That asymmetry is deliberate: failing to
 * read `/proc/<pid>/environ` (a permission error, a process exiting under the
 * read) is indistinguishable at the call site from "this bus has no display",
 * and treating an unreadable process as garbage is how a sweep graduates from
 * reaping residue to killing live work.
 */
export function selectStaleBuses(
  procs: readonly A11yBusProcess[],
  policy: SweepPolicy,
): SweepDecision {
  const minAgeSec = policy.minAgeSec ?? DEFAULT_MIN_AGE_SEC;
  const reap: A11yBusProcess[] = [];
  const keep: { proc: A11yBusProcess; reason: KeepReason }[] = [];

  for (const proc of procs) {
    if (proc.display === null) {
      keep.push({ proc, reason: 'display-unknown' });
      continue;
    }
    if (policy.liveDisplays.has(proc.display)) {
      keep.push({ proc, reason: 'display-live' });
      continue;
    }
    if (proc.ageSec < minAgeSec) {
      keep.push({ proc, reason: 'too-young' });
      continue;
    }
    reap.push(proc);
  }

  return { reap, keep };
}

/**
 * Parse the `--config-file=/tmp/pcv/pc-a11y-XXXX/session.conf` argument that
 * identifies one of our buses. Returns null for any other dbus-daemon on the
 * host — the session bus of a real login, a container's, an at-spi accessibility
 * bus — none of which this sweep may ever touch.
 */
export function parseA11yConfDir(cmdline: string): string | null {
  const match = /--config-file=(\/[^\s\0]*\/pc-a11y-[A-Za-z0-9]+)\/session\.conf/.exec(cmdline);
  return match ? match[1] : null;
}

/** Extract `DISPLAY` from a NUL-separated `/proc/<pid>/environ` blob. */
export function parseDisplayFromEnviron(environ: string): string | null {
  for (const entry of environ.split('\0')) {
    if (entry.startsWith('DISPLAY=')) {
      const value = entry.slice('DISPLAY='.length);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/**
 * Field 22 of `/proc/<pid>/stat` in clock ticks since boot. `comm` (field 2) is
 * unquoted and may contain spaces AND parentheses, so the split has to happen
 * after the LAST ')' rather than at the first whitespace run.
 */
export function parseStartTimeTicks(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  // stat field 22 is the 20th entry after `state`, which is fields[0] here.
  const ticks = Number(fields[19]);
  return Number.isFinite(ticks) ? ticks : null;
}

/** Everything the sweep touches outside itself, injected so the policy stays testable. */
export interface SweepIo {
  /** Every pid on the host, as strings. */
  listPids(): readonly number[];
  readCmdline(pid: number): string | null;
  readEnviron(pid: number): string | null;
  /** Age in seconds, or null when the process vanished under the read. */
  ageSec(pid: number): number | null;
  /** Displays currently backed by an X server. */
  liveDisplays(): ReadonlySet<string>;
  kill(pid: number, signal: NodeJS.Signals): void;
  log(message: string): void;
}

/** Walk the host's processes and keep only the a11y session buses we started. */
export function collectA11yBuses(io: SweepIo): A11yBusProcess[] {
  const found: A11yBusProcess[] = [];
  for (const pid of io.listPids()) {
    const cmdline = io.readCmdline(pid);
    if (cmdline === null) continue;
    const confDir = parseA11yConfDir(cmdline);
    if (confDir === null) continue;
    const ageSec = io.ageSec(pid);
    if (ageSec === null) continue;
    const environ = io.readEnviron(pid);
    found.push({
      pid,
      confDir,
      display: environ === null ? null : parseDisplayFromEnviron(environ),
      ageSec,
    });
  }
  return found;
}

export interface SweepResult {
  scanned: number;
  reaped: number[];
  /** Selected for reaping but skipped because identity no longer matched at kill time. */
  raced: number[];
  kept: number;
}

/**
 * Collect, decide, and TERM. SIGTERM (never SIGKILL) is deliberate: the daemon's
 * own shutdown tears down the at-spi children it activated, which a KILL would
 * strand — the leak this exists to close, one level down.
 *
 * ⚠ IDENTITY IS RE-VERIFIED IMMEDIATELY BEFORE EACH KILL. PID wrap happens
 * roughly daily on a box under fleet load, so a pid measured at the top of this
 * function can belong to an unrelated process by the time the loop reaches it.
 * Re-reading the cmdline and requiring the SAME conf dir makes a recycled pid
 * un-killable rather than a coin flip — the same reason `processes:kill` refuses
 * on `identity_mismatch` instead of trusting the id it was handed.
 */
export function sweepA11yBuses(io: SweepIo, policy: Partial<SweepPolicy> = {}): SweepResult {
  const procs = collectA11yBuses(io);
  const { reap, keep } = selectStaleBuses(procs, {
    liveDisplays: policy.liveDisplays ?? io.liveDisplays(),
    minAgeSec: policy.minAgeSec,
  });

  const reaped: number[] = [];
  const raced: number[] = [];
  for (const proc of reap) {
    const stillOurs = io.readCmdline(proc.pid);
    if (stillOurs === null || parseA11yConfDir(stillOurs) !== proc.confDir) {
      raced.push(proc.pid);
      continue;
    }
    try {
      io.kill(proc.pid, 'SIGTERM');
      reaped.push(proc.pid);
    } catch {
      // Already exited between the re-verify and the signal; indistinguishable
      // from success for our purposes.
      raced.push(proc.pid);
    }
  }

  if (reaped.length > 0 || raced.length > 0) {
    io.log(
      `[a11y-bus-sweep] scanned=${procs.length} reaped=${reaped.length} raced=${raced.length} kept=${keep.length}`,
    );
  }
  return { scanned: procs.length, reaped, raced, kept: keep.length };
}
