/**
 * Wait for the browser main thread to reach a measurable quiet window.
 *
 * A first-render marker is not a usable performance baseline: hydration,
 * route data, and pane mounts can still be consuming the main thread after the
 * marker fires. This barrier waits for a bounded run of requestAnimationFrame
 * deltas at or below the frame budget before a caller drives its interaction.
 * It deliberately uses rAF rather than PerformanceObserver('longtask'), which
 * is not implemented by every WebKit runtime used by the desktop test rig.
 *
 * The function is self-contained so its source can be injected into a page by
 * a WebDriver or Tauri evaluator. Tests provide the runtime explicitly; the
 * browser uses the globals discovered through globalThis.
 */

export const MAIN_THREAD_QUIET_DEFAULTS = {
  quietFrameMs: 20,
  consecutiveFrames: 10,
  timeoutMs: 15_000,
} as const;

export interface MainThreadQuietOptions {
  /** Maximum rAF delta that counts as a quiet frame. */
  quietFrameMs?: number;
  /** Number of consecutive quiet frames required before the barrier passes. */
  consecutiveFrames?: number;
  /** Bounded wait; a timeout returns `ok: false` instead of hanging a suite. */
  timeoutMs?: number;
}

export interface MainThreadQuietRuntime {
  /** Monotonic clock in milliseconds, normally performance.now. */
  now: () => number;
  /** Schedule the next frame; the callback need not receive a timestamp. */
  requestAnimationFrame: (callback: () => void) => unknown;
}

export interface MainThreadQuietResult {
  /** True only when the required consecutive quiet frames were observed. */
  ok: boolean;
  /** Elapsed monotonic time observed when the barrier settled. */
  elapsedMs: number;
  /** Number of rAF callbacks observed before settling. */
  framesObserved: number;
  /** Quiet-frame streak at the point the barrier settled. */
  consecutiveFrames: number;
  /** Largest observed rAF delta in the wait window. */
  maxFrameMs: number;
}

/**
 * Wait for the main thread to be quiet, or return a bounded timeout result.
 *
 * `runtime` is optional for browser injection and explicit for deterministic
 * unit tests. The timeout is checked on every animation frame: if the main
 * thread is blocked, the next frame after it yields observes the elapsed gap
 * and cannot falsely count that gap as quiet.
 */
export async function waitForMainThreadQuiet(
  options: MainThreadQuietOptions = {},
  runtime?: MainThreadQuietRuntime,
): Promise<MainThreadQuietResult> {
  // Keep the defaults INSIDE the function body. WebDriver/Tauri callers inject
  // this primitive into the page with `waitForMainThreadQuiet.toString()`, so a
  // reference to the exported module constant would become an unbound lexical
  // in the page realm (WI-5502). The exported constant remains the public/test
  // contract; the serialization regression test pins these values together.
  const defaults = {
    quietFrameMs: 20,
    consecutiveFrames: 10,
    timeoutMs: 15_000,
  } as const;
  const quietFrameMs = Math.max(
    0,
    options.quietFrameMs ?? defaults.quietFrameMs,
  );
  const neededFrames = Math.max(
    1,
    Math.floor(options.consecutiveFrames ?? defaults.consecutiveFrames),
  );
  const timeoutMs = Math.max(0, options.timeoutMs ?? defaults.timeoutMs);

  const globals = globalThis as unknown as {
    performance?: { now: () => number };
    requestAnimationFrame?: (callback: () => void) => unknown;
  };
  const now = runtime?.now ?? (() => globals.performance?.now() ?? Date.now());
  const requestFrame =
    runtime?.requestAnimationFrame ??
    ((callback: () => void) => {
      if (!globals.requestAnimationFrame) {
        throw new Error('requestAnimationFrame is unavailable; pass an explicit runtime');
      }
      return globals.requestAnimationFrame(callback);
    });

  const startedAt = now();
  let previousAt = startedAt;
  let framesObserved = 0;
  let calmFrames = 0;
  let maxFrameMs = 0;

  return new Promise<MainThreadQuietResult>((resolve) => {
    const finish = (ok: boolean, settledAt: number) => {
      resolve({
        ok,
        elapsedMs: Math.max(0, settledAt - startedAt),
        framesObserved,
        consecutiveFrames: calmFrames,
        maxFrameMs,
      });
    };

    const tick = () => {
      const currentAt = now();
      const frameMs = Math.max(0, currentAt - previousAt);
      previousAt = currentAt;
      framesObserved += 1;
      maxFrameMs = Math.max(maxFrameMs, frameMs);
      calmFrames = frameMs <= quietFrameMs ? calmFrames + 1 : 0;

      if (calmFrames >= neededFrames) {
        finish(true, currentAt);
        return;
      }
      if (currentAt - startedAt >= timeoutMs) {
        finish(false, currentAt);
        return;
      }
      requestFrame(tick);
    };

    requestFrame(tick);
  });
}
