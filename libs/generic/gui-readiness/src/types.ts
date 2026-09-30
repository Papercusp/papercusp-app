/**
 * Types for the GUI process/window readiness + cold-start measurement helper.
 *
 * The core failure this library exists to prevent: a naive readiness wait keyed
 * to a ONE-SHOT (edge-triggered) signal — "grep the log for the line that appears
 * once at startup", "resolve when the webview fires its first `did-finish-load`" —
 * hangs FOREVER when the caller attaches to a PERSISTENT process that was already
 * ready before the wait began, because that one-shot signal already fired in the
 * past and will never fire again. Every probe here is LEVEL-triggered (poll the
 * CURRENT state) and every wait carries a hard wall-clock deadline, so attaching
 * to an already-ready process resolves on the very first check and a wedged one
 * still returns (not hangs) once the deadline elapses.
 */

/** Polls the CURRENT readiness state — never an edge/one-shot event. */
export interface ReadinessProbe {
  /**
   * Resolve `true` iff the window/process is ready RIGHT NOW. Called repeatedly
   * (level-triggered polling), so it must reflect current state, not "has the
   * ready event fired since some earlier instant". The caller should keep this
   * cheap; the wait loop separately bounds each call with `probeTimeoutMs`, so a
   * probe implementation does not need its own internal timeout to be safe.
   */
  checkReady(): Promise<boolean>;
}

/** Optional liveness check so a dead process fails fast instead of waiting out the full deadline. */
export interface LivenessProbe {
  /** Resolve `true` iff the underlying process is still alive. */
  isAlive(): Promise<boolean>;
}

export interface WaitOptions {
  /** Hard wall-clock budget for the whole wait, in ms. There is no "wait forever" mode — this is required. */
  timeoutMs: number;
  /** Delay between readiness polls, in ms. Default 250. The very first check runs immediately, with no initial delay. */
  pollIntervalMs?: number;
  /**
   * Per-call bound on `checkReady()`/`isAlive()`, in ms, so a single wedged probe
   * call can't silently consume (or exceed) the whole budget. Default:
   * `min(timeoutMs, 5000)`. A probe call that exceeds this is treated as "not
   * ready this round" (or "alive, unknown" for liveness) and the loop continues.
   */
  probeTimeoutMs?: number;
  /** Injectable clock — real `Date.now` by default. Tests pass a fake, deterministic clock. */
  now?: () => number;
  /** Injectable delay — real `setTimeout`-based sleep by default. Tests pass a no-op/instant sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export type ReadinessFailureReason = 'timeout' | 'process_exited';

export type ReadinessOutcome =
  | { ok: true; ready: true; elapsedMs: number }
  | { ok: false; ready: false; elapsedMs: number; reason: ReadinessFailureReason };

/**
 * `false` when this call attached to a process that may already have been
 * running before the wait began (its true birth time is unknown/unowned by this
 * call) — `coldStartMs` is then always `null`, never fabricated from however long
 * *this call* happened to wait. `true` only when the caller itself observed the
 * process's birth (it just launched it) and passes that instant as `launchedAtMs`.
 */
export type ProcessOrigin = 'launched' | 'attached';

export interface ColdStartOptions extends WaitOptions {
  origin: ProcessOrigin;
  /**
   * The instant (per `now()`) the process was launched. Required when
   * `origin === 'launched'`; ignored (and `coldStartMs` stays `null`) when
   * `origin === 'attached'`. Defaults to the instant `measureGuiColdStart` is
   * called, if omitted for a `'launched'` origin.
   */
  launchedAtMs?: number;
}

export interface ColdStartResult {
  ok: boolean;
  ready: boolean;
  origin: ProcessOrigin;
  /** Wall-clock ms this call itself spent waiting (always set, regardless of origin/outcome). */
  waitedMs: number;
  /**
   * ms from process birth to ready. Only ever set for `origin === 'launched'`
   * AND `ready === true` — `null` for an attached/persistent process (measuring
   * "cold start" for a process whose birth this call never observed would be a
   * fabricated number, not a measurement) and `null` on a failed/timed-out wait.
   */
  coldStartMs: number | null;
  reason?: ReadinessFailureReason;
}
