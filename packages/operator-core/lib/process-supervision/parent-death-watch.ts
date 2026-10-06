import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { managedSetInterval } from '@papercusp/scheduled-registry';

const PROCESS_START_PPID = process.ppid;
const PAPERCUSP_DIR = process.env.PAPERCUSP_HOME || join(homedir(), '.papercusp');
const log = (message: string): void => console.log(`[serve] ${message}`);

/**
 * Durable sink for the parent-death decision. The gateway already owns
 * `gateway.log`; use that exact surface in gateway-sidecar mode so its next
 * postmortem has the watch decision and the SIGTERM drain outcome in one file.
 * Other packaged sidecars share this entrypoint but not the gateway logger, so
 * they use one small lifecycle log under PAPERCUSP_HOME instead of depending on
 * their already-broken stdout pipe.
 */
function parentDeathLogPath(): string {
  if (process.env.PAPERCUSP_GATEWAY_SIDECAR_MODE === "1") {
    return (
      process.env.PAPERCUSP_GATEWAY_LOG ||
      join(homedir(), ".papercusp", "gateway.log")
    );
  }
  return join(PAPERCUSP_DIR, "parent-death.log");
}

function writeParentDeathDiagnostic(message: string): void {
  try {
    const path = parentDeathLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `[serve-parent-watch ${new Date().toISOString()}] ${message}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Diagnostics must never block the termination path. `log()` below remains
    // the best-effort console fallback when the file is unavailable.
  }
}
/** True if a process with `pid` exists (signal 0 probe). */
export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but not ours.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * (EI-8894) True when a process's parent has changed since we recorded
 * `originalPpid` at startup — i.e. we've been reparented/orphaned.
 *
 * Only meaningful on Unix: a hard-killed parent (SIGKILL, `launchctl
 * kickstart -k`, a crash — anything that skips OUR OWN SIGTERM handler)
 * never runs the desktop app's graceful `shutdown_children` teardown, so a
 * managed sidecar can otherwise run forever as a zombie holding ports/
 * storage under stale env (the "runaway serve.mjs --ensure at 357% CPU"
 * symptom). Comparing the live ppid against the ppid recorded at spawn is
 * portable across whatever the OS reparents orphans to (traditionally pid
 * 1, but not guaranteed) — ANY change means our original parent is gone.
 */
export function isOrphanedFromParent(
  originalPpid: number,
  currentPpid: number,
): boolean {
  return originalPpid > 0 && currentPpid !== originalPpid;
}

/**
 * (EI-8894) Start a low-frequency watch that self-terminates this process
 * (via `onOrphaned`, expected to be the same graceful `shutdown()` the
 * SIGTERM handler uses) the moment our desktop parent dies WITHOUT signaling
 * us first. Desktop-managed only (`PAPERCUSP_DESKTOP === '1'` — the same
 * marker `resolveStickyPort` already gates on): a plain dev/CLI `serve` has
 * no such parent contract and legitimately outlives its launching shell.
 */
/**
 * (EI-19486216732882752) The pid the LAUNCHER declared as our parent, when it
 * told us (`PAPERCUSP_DESKTOP_PARENT_PID`, set by main.rs's `spawn_serve`).
 *
 * Why an env handoff rather than just reading `process.ppid`: a ppid read is an
 * OBSERVATION whose correctness depends on when it happens, and every window in
 * which it can be wrong is a window in which the watch goes permanently blind.
 * A declared pid is an IDENTITY — it stays correct no matter how late we read it,
 * which is what lets us also answer "is that parent still alive?" rather than only
 * "has my ppid changed since I looked?".
 *
 * Falls back to the module-load ppid when the launcher did not declare one (an
 * older packaged app against a newer sidecar), which preserves the pre-existing
 * reparent-only semantics exactly.
 */
export function resolveExpectedParentPid(
  // Record<…>, not NodeJS.ProcessEnv and not an all-optional literal shape.
  // NodeJS.ProcessEnv here is Next.js's augmentation (NODE_ENV is REQUIRED), so
  // demanding it forces every test caller into an `as` cast that typechecks
  // nothing; but an all-optional literal type is a WEAK type, and assigning
  // process.env to it fails TS2559 ("no properties in common") because an index
  // signature does not count as an overlapping declared property. Record<> matches
  // ProcessEnv's index signature and accepts a bare `{}` from tests.
  env: Record<string, string | undefined> = process.env,
  fallbackPpid: number = PROCESS_START_PPID,
): { pid: number; declaredByLauncher: boolean } {
  const raw = env.PAPERCUSP_DESKTOP_PARENT_PID;
  const n = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (Number.isInteger(n) && n > 0) return { pid: n, declaredByLauncher: true };
  return { pid: fallbackPpid, declaredByLauncher: false };
}

/**
 * (EI-8894) Start a low-frequency watch that self-terminates this process
 * (via `onOrphaned`, expected to be the same graceful `shutdown()` the
 * SIGTERM handler uses) the moment our desktop parent dies WITHOUT signaling
 * us first. Desktop-managed only (`PAPERCUSP_DESKTOP === '1'` — the same
 * marker `resolveStickyPort` already gates on): a plain dev/CLI `serve` has
 * no such parent contract and legitimately outlives its launching shell.
 *
 * (EI-19486216732882752) Two changes that turn this from "usually works" into
 * "cannot go blind":
 *  1. The reference ppid is captured at MODULE LOAD (or declared outright by the
 *     launcher), never at arm time — see PROCESS_START_PPID for the race.
 *  2. It checks ONCE IMMEDIATELY as well as on the interval, so a parent that
 *     died during boot is caught before we finish booting (and before we pay for
 *     embedded Postgres) instead of up to 5s later — or, in the blind case that
 *     produced the 3-core/18.4GB fire, never.
 *
 * ⚠ Do NOT "simplify" the orphan test to `process.ppid === 1`. On this box an
 * orphan reparents to `systemd --user` (pid 2026497), not to pid 1, so that test
 * silently matches nothing — and main.rs:8243 documents the converse hazard on
 * macOS, where a launchd-launched app has PPID==1 while perfectly healthy.
 */
export function startParentDeathWatch(
  onOrphaned: () => void,
  opts: {
    expectedPpid?: number;
    declaredByLauncher?: boolean;
    parentAlive?: (pid: number) => boolean;
    currentPpid?: () => number;
  } = {},
): void {
  if (process.env.PAPERCUSP_DESKTOP !== "1") return;
  // Headless rig frames (deb-hetzner-matrix / local-matrix) run the packaged
  // sidecar with PAPERCUSP_DESKTOP=1 for production parity but launch it from a
  // shell that exits right after spawn — there IS no desktop parent, so this
  // watch would kill the instance seconds after boot (2026-07-16 local-matrix
  // gate RED: frame A self-terminated mid-initdb on the launcher bash exiting).
  // Those launchers opt out explicitly; a real desktop never sets this.
  if (process.env.PAPERCUSP_PARENT_DEATH_WATCH === "0") return;

  const resolved = resolveExpectedParentPid();
  const originalPpid = opts.expectedPpid ?? resolved.pid;
  const declaredByLauncher = opts.declaredByLauncher ?? resolved.declaredByLauncher;
  const isAlive = opts.parentAlive ?? pidAlive;
  const readPpid = opts.currentPpid ?? (() => process.ppid);
  if (!(originalPpid > 0)) return;

  const orphanReason = (): string | null => {
    const currentPpid = readPpid();
    if (isOrphanedFromParent(originalPpid, currentPpid)) {
      return `now reparented to ${currentPpid}`;
    }
    // Only sound when the launcher DECLARED its pid: then it is an identity we
    // can outlive-check. Against a bare ppid read this would be self-referential
    // — the value may ALREADY be the reparent target, which is alive by
    // definition — so the fallback path deliberately keeps reparent-only
    // semantics rather than guessing.
    if (declaredByLauncher && !isAlive(originalPpid)) {
      return `declared parent pid is no longer alive (ppid now ${currentPpid})`;
    }
    return null;
  };

  const fire = (why: string): void => {
    const message =
      `desktop parent pid ${originalPpid} is gone (${why}) — ` +
      "self-terminating instead of running orphaned";
    // Write the durable evidence FIRST: the parent just died, so stdout may
    // already be a broken pipe and its silence is not evidence that fire()
    // failed to run (WI-39599).
    writeParentDeathDiagnostic(message);
    log(message);
    onOrphaned();
  };

  // Check once before arming: if the parent died during boot we are ALREADY
  // orphaned, and waiting a full interval to notice is the cheap half of the bug.
  const immediate = orphanReason();
  if (immediate) {
    fire(`${immediate}, detected before the watch armed`);
    return;
  }

  managedSetInterval(
    "serve-desktop-parent-death-watch",
    5000,
    () => {
      const why = orphanReason();
      if (why) fire(why);
    },
    {
      category: "watchdog",
      classification: "must-sample",
      // This watchdog has an explicit fake-timer regression test for the
      // healthy-arm -> parent-dies interval path. The scheduled registry is
      // inert under Vitest unless a deliberately exercised timer opts in.
      allowInTest: true,
    },
  );
}

/**
 * Arm the parent-death watch for a packaged sidecar before its sidecar module
 * is imported. Sidecar entrypoints own their graceful SIGTERM handlers, so the
 * watch hands the signal back to the process instead of duplicating cleanup
 * here. The signal callback is injectable for the lifecycle regression tests.
 */
export function startSidecarParentDeathWatch(
  opts: Parameters<typeof startParentDeathWatch>[1] = {},
  sendSignal: (signal: NodeJS.Signals) => void = (signal) =>
    process.kill(process.pid, signal),
): void {
  startParentDeathWatch(() => sendSignal("SIGTERM"), opts);
}
