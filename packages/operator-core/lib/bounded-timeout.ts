/**
 * bounded-timeout — race a promise against a deadline; degrade to a fallback
 * value instead of hanging (or failing the whole caller) when the promise is
 * too slow (WI-3818).
 *
 * WHY: fleet:status (+ coord:orient's fleet-health fold) fan out to several
 * independent PG reads (presence, assignments, completion-stats, per-member
 * Tier-1/wakeability). None of those sub-reads carried an internal budget, so
 * during the 2026-07-10 host-load storm ANY ONE of them stalling silently
 * blocked the WHOLE call until the 55s MCP client timeout fired — the caller
 * got NOTHING back instead of a slim-but-usable partial result. Wrapping each
 * sub-read in `withBoundedTimeout` bounds the blast radius of one slow leg to
 * its own `timeoutMs` and lets the caller assemble a degraded-but-useful
 * response from whichever legs answered in time.
 *
 * Promise inputs retain the legacy best-effort behaviour because they have
 * already started by the time this helper sees them. Callers that own the
 * operation's start should pass a thunk: it is invoked only after the race is
 * armed and receives a child AbortSignal that fires when the deadline (or an
 * optional parent signal) fires. Cancellation-aware callers can then stop the
 * underlying query instead of leaving abandoned work running after the
 * fallback is returned.
 */

export interface BoundedTimeoutResult<T> {
  value: T;
  /** true when cancellation/deadline fired first (fallback used) or the work threw. */
  degraded: boolean;
  /** Why `degraded` is true — absent when not degraded. */
  reason?: 'timeout' | 'aborted' | 'error';
  /** The error message, when `reason === 'error'`. */
  errorMessage?: string;
  /** The original thrown value, when `reason === 'error'`. Internal callers may use this to
   * distinguish a typed, retryable failure from an unexpected error without matching text. */
  error?: unknown;
  elapsedMs: number;
}

const TIMEOUT_SENTINEL = Symbol('bounded-timeout:deadline');
const ABORTED_SENTINEL = Symbol('bounded-timeout:aborted');

export interface BoundedTimeoutOptions<T> {
  fallback: T;
  timeoutMs: number;
  label?: string;
  /** Abort the bounded operation when the caller's operation is cancelled. */
  signal?: AbortSignal;
}

/**
 * Run `work` (a promise, or a promise-returning thunk). Promise inputs are
 * already running and can only be observed; a thunk is deferred until the
 * timeout race is armed and receives a child signal for cancellation. Resolves
 * within `timeoutMs` + a tick, NEVER throws and NEVER hangs past the deadline.
 */
export async function withBoundedTimeout<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  opts: BoundedTimeoutOptions<T>,
): Promise<BoundedTimeoutResult<T>> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeParentAbortListener: (() => void) | undefined;
  const cancellation = new Promise<typeof TIMEOUT_SENTINEL | typeof ABORTED_SENTINEL>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('bounded timeout exceeded'));
      resolve(TIMEOUT_SENTINEL);
    }, Math.max(1, opts.timeoutMs));
    if (opts.signal) {
      const onParentAbort = () => {
        controller.abort(opts.signal?.reason);
        resolve(ABORTED_SENTINEL);
      };
      if (opts.signal.aborted) onParentAbort();
      else {
        opts.signal.addEventListener('abort', onParentAbort, { once: true });
        removeParentAbortListener = () => opts.signal?.removeEventListener('abort', onParentAbort);
      }
    }
  });
  let promise: Promise<T> | undefined;
  try {
    if (opts.signal?.aborted) {
      return { value: opts.fallback, degraded: true, reason: 'aborted', elapsedMs: Date.now() - startedAt };
    }
    // A late resolution/rejection arriving after we've already degraded must
    // never become an unhandled rejection. Promise.resolve().then also turns a
    // synchronous thunk throw into the normal degraded error path.
    promise = typeof work === 'function' ? Promise.resolve().then(() => work(controller.signal)) : Promise.resolve(work);
    promise.catch(() => {});
    const result = await Promise.race([promise, cancellation]);
    if (result === TIMEOUT_SENTINEL) {
      console.warn(
        `[bounded-timeout]${opts.label ? ` ${opts.label}` : ''} exceeded ${opts.timeoutMs}ms — degrading to fallback`,
      );
      return { value: opts.fallback, degraded: true, reason: 'timeout', elapsedMs: Date.now() - startedAt };
    }
    if (result === ABORTED_SENTINEL) {
      return { value: opts.fallback, degraded: true, reason: 'aborted', elapsedMs: Date.now() - startedAt };
    }
    return { value: result as T, degraded: false, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(
      `[bounded-timeout]${opts.label ? ` ${opts.label}` : ''} failed: ${errorMessage} — degrading to fallback`,
    );
    return {
      value: opts.fallback,
      degraded: true,
      reason: 'error',
      errorMessage,
      error: err,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    if (timer) clearTimeout(timer);
    removeParentAbortListener?.();
  }
}
