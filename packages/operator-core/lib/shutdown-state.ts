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
import { pinModuleState } from '@papercusp/module-singleton';

interface BeforeHostExitHook {
  label: string;
  run: () => void;
}

interface ShutdownState {
  shuttingDown: boolean;
  /** Set once installGracefulShutdown has armed a drain in THIS process. */
  gracefulDrainInstalled: boolean;
  beforeHostExitHooks: BeforeHostExitHook[];
  beforeHostExitRan: boolean;
}

// Pinned (not a bare module `let`): the drain flag is WRITTEN by host-recycle.ts and
// READ by sidecar shutdown listeners in other modules. A split module record would
// leave the reader on a copy that never sees the write — a sidecar would then stop at
// SIGTERM again, or a before-exit hook would register where exitOnce never looks.
const state = pinModuleState<ShutdownState>('@papercusp/operator-core.shutdownState', () => ({
  shuttingDown: false,
  gracefulDrainInstalled: false,
  beforeHostExitHooks: [],
  beforeHostExitRan: false,
}));

/**
 * True once this process has begun a graceful drain (SIGTERM/SIGINT). One-way in
 * production (a draining process is on its way out). Cheap — a bare boolean read.
 */
export function isShuttingDown(): boolean {
  return state.shuttingDown;
}

/**
 * Mark this process as draining. Idempotent; called from the graceful-shutdown
 * handlers (installGracefulShutdown's drainAndExit + the cluster-primary shutdown).
 */
export function markShuttingDown(): void {
  state.shuttingDown = true;
}

/**
 * EI-24863236643374267: record that this process has a bounded graceful drain armed
 * (host-recycle.ts installGracefulShutdown). Set at INSTALL time, not at SIGTERM,
 * because listeners registered before the drain's own SIGTERM listener (a sidecar's
 * shutdown hook) run first and must already know a drain is coming.
 */
export function markGracefulDrainInstalled(): void {
  state.gracefulDrainInstalled = true;
}

/** True when a graceful drain is armed in this process (see markGracefulDrainInstalled). */
export function isGracefulDrainInstalled(): boolean {
  return state.gracefulDrainInstalled;
}

/**
 * Register a SYNCHRONOUS hook that runs right before the host process exits from a
 * graceful drain or recycle (host-recycle.ts gracefulHostRecycle → exitOnce). That
 * exit is usually a SIGKILL of itself, so Node's 'exit' event never fires — this is
 * the last point where the process can still act. The hook must not await: nothing
 * after it gets another turn. Re-registering the same label replaces the old hook.
 */
export function onBeforeHostExit(label: string, run: () => void): void {
  const i = state.beforeHostExitHooks.findIndex((h) => h.label === label);
  if (i >= 0) state.beforeHostExitHooks[i] = { label, run };
  else state.beforeHostExitHooks.push({ label, run });
}

/**
 * Run every before-host-exit hook once, in registration order. A throwing hook is
 * logged and skipped so it cannot stop the exit or the hooks after it. Idempotent:
 * a second call (the hard-exit timer racing the clean path) runs nothing.
 */
export function runBeforeHostExitHooks(): void {
  if (state.beforeHostExitRan) return;
  state.beforeHostExitRan = true;
  for (const hook of state.beforeHostExitHooks) {
    try {
      hook.run();
    } catch (err) {
      console.warn(`[shutdown-state] before-exit hook '${hook.label}' threw: ${String(err)}`);
    }
  }
}

/** Test seam ONLY — reset the flag between cases. Never call in production code. */
export function __resetShutdownStateForTest(): void {
  state.shuttingDown = false;
  state.gracefulDrainInstalled = false;
  state.beforeHostExitHooks = [];
  state.beforeHostExitRan = false;
}
