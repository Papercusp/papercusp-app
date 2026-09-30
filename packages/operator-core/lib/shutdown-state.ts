/**
 * shutdown-state.ts — a per-process "are we draining?" flag (infra round-4 P-005).
 *
 * On SIGTERM/SIGINT a deploy or `systemctl restart` puts the host process into a
 * bounded graceful drain (host-recycle.ts `installGracefulShutdown`, and the
 * cluster-primary shutdown handler in hono-host.ts). Anything that STARTS new
 * long-running work during that window is the problem — most acutely the
 * auto-implement dispatch loop, which spawns an agent that runs for minutes. A
 * worker spawned just as the drain begins is SIGKILL'd mid-fix when the drain's
 * hard-exit backstop fires, orphaning its claim and churning re-dispatch across
 * the deploy (the 2026-06-19 storm: 51/58 workers exited 143). This module lets
 * those call sites cheaply ask "are we shutting down?" and decline to start.
 *
 * Per-process BY DESIGN: each process owns its own SIGTERM and its own claims, so
 * a module global is exactly the right scope (the same shape as the event-loop-lag
 * gauge). markShuttingDown() is wired into the graceful-shutdown handlers; it is
 * one-way — a process that has begun draining never un-drains, it exits. The only
 * un-set is the test-reset seam.
 */
let _shuttingDown = false;

/**
 * True once this process has begun a graceful drain (SIGTERM/SIGINT). One-way in
 * production (a draining process is on its way out). Cheap — a bare boolean read.
 */
export function isShuttingDown(): boolean {
  return _shuttingDown;
}

/**
 * Mark this process as draining. Idempotent; called from the graceful-shutdown
 * handlers (installGracefulShutdown's drainAndExit + the cluster-primary shutdown).
 */
export function markShuttingDown(): void {
  _shuttingDown = true;
}

/** Test seam ONLY — reset the flag between cases. Never call in production code. */
export function __resetShutdownStateForTest(): void {
  _shuttingDown = false;
}
