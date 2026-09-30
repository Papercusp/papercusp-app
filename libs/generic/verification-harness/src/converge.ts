/**
 * The shared wait-for-convergence helper for cross-host observations.
 *
 * ## The defect class this exists to close
 * An expensive harness (a two-machine drill, a release cut, a headless UI run) triggers
 * an ASYNC action on one host and then reads the effect on another. If it reads ONCE,
 * the verdict depends on timing, not on the product: P-505 runs 27 and 30 failed with
 * "not converged" because a single read came 7-23 s after the action. Both hosts
 * converged within minutes. Each phase that hit this grew its own deadline+sleep loop,
 * and each loop had its own subtle difference (one discarded the last observation on
 * timeout, one slept before the first read, one had no ceiling).
 *
 * This is the one helper they all use instead:
 * - LEVEL-triggered: the first read happens immediately, and every later read is a
 *   fresh read of current state.
 * - Value-carrying: the result always holds the LAST observation and the reasons it
 *   still lagged. A timeout keeps the evidence and does not replace it with a bare
 *   "timed out".
 * - Bounded: `budgetMs` is validated and capped by `maxBudgetMs`. A budget of 0 is an
 *   explicit single read, so a caller that means "read once" has to say so.
 * - `between` runs between polls (for example to nudge git-sync), never before the
 *   first read and never after the deadline.
 *
 * `waitUntilReady` (`@papercusp/gui-readiness`) is the boolean readiness sibling. It
 * doesn't fit here because it returns only ready/not-ready and drops the observation,
 * and for a drill that observation is the evidence the validator judges.
 */

/** Greppable marker a timed-out convergence carries in its message. */
export const CONVERGENCE_TIMEOUT_MARKER = 'CONVERGENCE_TIMEOUT' as const;

/** Default ceiling on any single wait: a drill phase deadline is 20 minutes. */
export const CONVERGENCE_MAX_BUDGET_MS = 20 * 60_000;

export interface WaitForConvergenceOptions<T> {
  /** What is being observed, for messages ("tower first-source namespace ref"). */
  what: string;
  /** One fresh read of current remote state. A throw propagates (a broken read is not lag). */
  observe: () => Promise<T>;
  /** Why `value` has not converged yet. An empty list means converged. */
  lagging: (value: T) => readonly string[];
  /** Total wait budget. 0 = one read, on purpose. */
  budgetMs: number;
  /** Delay between reads. */
  pollMs: number;
  /** Ceiling on `budgetMs`; defaults to {@link CONVERGENCE_MAX_BUDGET_MS}. */
  maxBudgetMs?: number;
  /** Runs between polls while budget remains (e.g. nudge a sync). */
  between?: (read: number) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ConvergenceResult<T> {
  what: string;
  converged: boolean;
  /** The last observation, converged or not. */
  value: T;
  /** Why the last observation still lagged; empty when converged. */
  lagging: string[];
  reads: number;
  elapsedMs: number;
  budgetMs: number;
}

/** Thrown by {@link requireConvergence}; carries the last observation as evidence. */
export class ConvergenceTimeoutError<T = unknown> extends Error {
  readonly result: ConvergenceResult<T>;
  constructor(result: ConvergenceResult<T>) {
    super(
      `${CONVERGENCE_TIMEOUT_MARKER}: ${result.what} did not converge within ${Math.round(result.budgetMs / 1000)}s ` +
        `(${result.reads} read${result.reads === 1 ? '' : 's'}); still lagging: ${result.lagging.join(', ')}`,
    );
    this.name = 'ConvergenceTimeoutError';
    this.result = result;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validate<T>(opts: WaitForConvergenceOptions<T>): number {
  const max = opts.maxBudgetMs ?? CONVERGENCE_MAX_BUDGET_MS;
  if (!opts.what) throw new Error('waitForConvergence: `what` is required');
  if (!Number.isFinite(max) || max < 0) {
    throw new Error(`waitForConvergence(${opts.what}): maxBudgetMs must be a non-negative finite number, got ${max}`);
  }
  if (!Number.isFinite(opts.budgetMs) || opts.budgetMs < 0 || opts.budgetMs > max) {
    throw new Error(`waitForConvergence(${opts.what}): budgetMs must be within [0, ${max}], got ${opts.budgetMs}`);
  }
  if (!Number.isFinite(opts.pollMs) || opts.pollMs <= 0) {
    throw new Error(`waitForConvergence(${opts.what}): pollMs must be a positive finite number, got ${opts.pollMs}`);
  }
  return opts.budgetMs;
}

/**
 * Read `observe()` until `lagging(value)` is empty or `budgetMs` runs out. It never
 * throws on timeout: `converged:false` plus the last value and its lagging reasons.
 */
export async function waitForConvergence<T>(opts: WaitForConvergenceOptions<T>): Promise<ConvergenceResult<T>> {
  const budgetMs = validate(opts);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const started = now();
  const deadline = started + budgetMs;
  let reads = 0;
  for (;;) {
    const value = await opts.observe();
    reads += 1;
    const lagging = [...opts.lagging(value)];
    const remaining = deadline - now();
    if (lagging.length === 0 || remaining <= 0) {
      return { what: opts.what, converged: lagging.length === 0, value, lagging, reads, elapsedMs: now() - started, budgetMs };
    }
    await sleep(Math.min(opts.pollMs, remaining));
    if (opts.between && deadline - now() > 0) await opts.between(reads);
  }
}

/** {@link waitForConvergence}, but a timeout throws {@link ConvergenceTimeoutError}. */
export async function requireConvergence<T>(opts: WaitForConvergenceOptions<T>): Promise<T> {
  const result = await waitForConvergence(opts);
  if (!result.converged) throw new ConvergenceTimeoutError(result);
  return result.value;
}
