/**
 * shutdown-deadline.ts — WI-2667 recurrence guard.
 *
 * The packaged Mac operator (2026-07-04 dogfood) received SIGTERM, ran its
 * shutdown handler, but the best-effort graceful `await pg.stop()` HUNG (pg_ctl
 * stalled on an already-dying postmaster), so `process.exit(0)` never ran. The
 * process stayed alive ~1h45m storming a dead DB (DBOS executor, append-heavy
 * invalidator, watchdogs all flailing) — AND, because it never exited, launchd
 * never respawned it, so Postgres never came back. See WI-2667.
 *
 * The invariant this module encodes: once a shutdown STARTS, the process ALWAYS
 * exits — even if the graceful async cleanup never resolves — by arming a hard
 * deadline BEFORE any await, running the synchronous must-do cleanup, then
 * racing the graceful stop against that deadline. Whichever completes first
 * exits exactly once. Extracted from `serve.ts`'s inline `shutdown()` closure so
 * the HANG path is unit-testable without actually terminating the test runner
 * (deps are injectable; the real handler passes `process.exit`).
 */

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ShutdownDeadlineDeps {
  /**
   * Synchronous, must-run cleanup — remove the discovery file, release the
   * cold-start lock, SIGINT the postmaster. Should swallow its own errors; if it
   * throws anyway, the armed deadline + graceful stop still guarantee exit.
   */
  syncCleanup: () => void;
  /**
   * Best-effort graceful async stop (`pg.stop()`). May hang forever or reject —
   * BOTH are tolerated; the deadline covers a hang and a reject is swallowed.
   */
  gracefulStop: () => Promise<void>;
  /** Terminate the process (the real handler passes `process.exit`). */
  exit: (code: number) => void;
  /** Hard deadline in ms after which we force-exit regardless of `gracefulStop`. */
  deadlineMs: number;
  /** Injectable timer seam (defaults to the global set/clearTimeout). */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Optional side-effect (logging) invoked when the deadline force-exits. */
  onForceExit?: () => void;
}

/**
 * Run a shutdown sequence that is GUARANTEED to exit.
 *
 * Order (identical to the original inline handler):
 *   1. arm the force-exit deadline FIRST (so a throw/hang below can't strand us),
 *   2. run the synchronous essential cleanup,
 *   3. race the best-effort graceful async stop against the deadline —
 *      graceful-done clears the deadline and exits; else the deadline exits.
 *
 * `exit` is called at most once (the first of {graceful, deadline} wins); in the
 * real handler `process.exit` is terminal so this guard only matters for tests.
 */
export function runShutdownWithDeadline(deps: ShutdownDeadlineDeps): void {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));

  let exited = false;
  const doExit = (code: number): void => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };

  // (1) Arm the hard deadline before anything that could hang or throw.
  const forceExit = setTimer(() => {
    deps.onForceExit?.();
    doExit(0);
  }, deps.deadlineMs);

  // (2) Synchronous must-do cleanup. Swallow — the deadline already covers exit.
  try {
    deps.syncCleanup();
  } catch {
    /* deadline + graceful stop still guarantee exit */
  }

  // (3) Best-effort graceful stop, racing the deadline.
  void (async () => {
    await deps.gracefulStop().catch(() => {});
    clearTimer(forceExit);
    doExit(0);
  })();
}
