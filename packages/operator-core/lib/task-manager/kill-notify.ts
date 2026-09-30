/**
 * EI-21905196224862433 — in-process notification bridge between task-manager's
 * kill paths (`killTask` in control.ts) and capability:bash's in-memory job
 * registry (bash-jobs.ts).
 *
 * WHY THIS EXISTS: a CONFINED (systemd `.service`-unit) background job is
 * watched by Node via the `systemd-run --pipe --wait` CLIENT process, not the
 * real payload — the payload runs inside the transient service, forked away
 * from the client. Empirically reproduced for this bug: that client exits 0
 * once the SERVICE UNIT is gone, REGARDLESS of whether the unit ended normally
 * or was killed out from under it. `systemctl kill --signal=SIGTERM <unit>`
 * (exactly what `processes:kill` sends) does not make the client's own exit
 * reflect an abnormal payload termination — a `sleep 60` job killed at ~10s
 * still reported `status=completed exit_code=0` to `capability:bash_output`,
 * with output truncated mid-command.
 *
 * bash-jobs.ts's OWN internal kill path (`killJob`, and the deadline-timeout
 * escalation) already compensates for this: both flip `job.status`
 * SYNCHRONOUSLY the instant a signal is sent — well before the systemd-run
 * client can possibly have exited — so the close handler's
 * `if (job.status === 'running') …` guard preserves that outcome instead of
 * trusting the untrustworthy `code`. (See `killJob`'s own comment: this is
 * kill-INTENT, not a liveness check, and is deliberately permanent even if the
 * process later exits cleanly on its own.)
 *
 * `processes:kill` (`killTask` in control.ts) is a second, independent caller
 * of the exact same `systemctl kill` mechanism, but it has no reference to
 * bash-jobs.ts's job object at all — so that compensation never ran for an
 * externally-initiated kill, and the close handler was left trusting `code`.
 *
 * This module is the decoupling seam: task-manager's kill paths call
 * `notifyTaskKillRequested` the instant they are about to signal a taskId,
 * synchronously and BEFORE the actual signal is sent (for the same
 * kill-intent-not-liveness reason `killJob` requires it to be synchronous —
 * see its comment). bash-jobs.ts subscribes once at module load and applies
 * the same synchronous `job.status = 'killed'` flip `killJob` already does
 * for its own kills. Kept as a bare pub/sub rather than an import in either
 * direction: task-manager is lower-level infra that must not depend on one
 * specific capability tool, and bash-jobs.ts already depends on task-manager,
 * so the reverse import would be circular.
 */

export type TaskKillListener = (taskId: string, signal: NodeJS.Signals) => void;

const listeners = new Set<TaskKillListener>();

/** Subscribe to kill-intent notifications. Returns an unsubscribe function. */
export function onTaskKillRequested(listener: TaskKillListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Announce that `signal` is ABOUT TO BE sent to `taskId` — callers MUST invoke
 * this synchronously, immediately before the actual `systemctl kill` /
 * `process.kill`, so a subscriber's own synchronous state flip lands well
 * before the signalled process can possibly have exited and its close handler
 * run. A listener that throws must never break the kill path reporting it —
 * errors are caught and logged, never rethrown.
 */
export function notifyTaskKillRequested(taskId: string, signal: NodeJS.Signals): void {
  for (const listener of listeners) {
    try {
      listener(taskId, signal);
    } catch (e) {
      console.warn(
        `[task-manager] kill-notify listener threw for task ${taskId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** Test-only: drop every registered listener so suites don't leak state into each other. */
export function _resetKillNotifyListenersForTest(): void {
  listeners.clear();
}
