/**
 * runWithRetry — generic governed retry-with-policy loop (resilience lib).
 *
 * Domain-INDEPENDENT: it knows nothing about agents, HTTP, or any provider. The caller's
 * `attempt()` runs the operation and returns either success (+optional rate-limit headers to
 * feed the governor) or a `RetryVerdict` — a tiny generic classification the loop acts on:
 *   - `retryable`   → retry (else return the verdict);
 *   - `accountWide` → pause the SHARED governor (so ALL callers wait) vs a per-call backoff;
 *   - `retryAfterMs`/`resetAt` → the server's hint, honored when present, else exponential
 *     backoff (so a hint-less 429/5xx doesn't hot-loop).
 * Acquire is abortable + maxWait-bounded → an interactive caller bails to a verdict instead
 * of inheriting a far-off shared pause. Reusable by any rate-limited/flaky I/O; the agent
 * layer wraps it with its own classifier (see ../agent/turn-runner).
 */
import type { AdmissionDenial, RateLimitGovernor, TokenEstimate } from './governor';

/** The generic, domain-free classification of a failed attempt. */
export interface RetryVerdict {
  retryable: boolean;
  /** True → account-wide backpressure (429/overload): pause the shared governor, not a local backoff. */
  accountWide: boolean;
  retryAfterMs?: number;
  resetAt?: number;
  message?: string;
  /** Opaque passthrough so the caller can recover its own richer error object. */
  detail?: unknown;
  admissionDenial?: AdmissionDenial;
}

export type AttemptOutcome<T> =
  | { ok: true; value: T; headers?: Record<string, string | undefined> }
  | { ok: false; error: RetryVerdict };

export type RetryResult<T> = { ok: true; value: T } | { ok: false; error: RetryVerdict };

export interface RetryOptions {
  estTokens?: TokenEstimate;
  maxAttempts?: number;
  maxWaitMs?: number;
  baseBackoffMs?: number;
  signal?: AbortSignal;
  /** Existing gateway priority tier, forwarded to the process-local governor. */
  priorityTier?: number;
}

export interface RetryDeps<T> {
  governor: RateLimitGovernor;
  attempt: () => Promise<AttemptOutcome<T>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_CAP_MS = 60_000;

export async function runWithRetry<T>(opts: RetryOptions, deps: RetryDeps<T>): Promise<RetryResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const maxWaitMs = opts.maxWaitMs ?? 600_000;
  const baseBackoffMs = opts.baseBackoffMs ?? 1000;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let last: RetryVerdict | undefined;
  let totalWaited = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let admissionDenial: AdmissionDenial | undefined;
    const release = await deps.governor.acquire(opts.estTokens, {
      signal: opts.signal,
      maxWaitMs: maxWaitMs - totalWaited,
      priorityTier: opts.priorityTier,
      onDenied: (denial) => {
        admissionDenial = denial;
      },
    });
    if (!release) {
      const pausedUntil = deps.governor.state.pausedUntil;
      return {
        ok: false,
        error: {
          retryable: false,
          accountWide: true,
          message: opts.signal?.aborted ? 'aborted while rate-limited' : 'rate-limit pause exceeds maxWait',
          ...(pausedUntil > now() ? { resetAt: pausedUntil } : {}),
          ...(admissionDenial ? { admissionDenial } : {}),
        },
      };
    }
    let backoffMs = 0;
    let verdict: RetryVerdict | undefined;
    try {
      const outcome = await deps.attempt();
      if (outcome.ok) {
        if (outcome.headers) deps.governor.recordResponse(outcome.headers);
        return { ok: true, value: outcome.value };
      }
      verdict = outcome.error;
      last = verdict;
      // Account-wide STOP with a known reset (e.g. a plan/usage cap — accountWide but NOT
      // retryable): pause the SHARED governor so the whole fleet backs off until reset, even
      // though THIS turn won't retry into the wall. Without this, a non-retryable account-wide
      // verdict returns immediately and peers keep hammering the capped account.
      if (verdict.accountWide && !verdict.retryable) {
        const until =
          verdict.retryAfterMs ?? (verdict.resetAt !== undefined ? Math.max(0, verdict.resetAt - now()) : undefined);
        if (until !== undefined && until > 0) {
          deps.governor.penalize({
            retryAfterMs: until,
            ...(verdict.resetAt !== undefined ? { resetAt: verdict.resetAt } : {}),
          });
        }
      }
      if (!verdict.retryable || attempt === maxAttempts) return { ok: false, error: verdict };

      const hintMs = verdict.accountWide
        ? verdict.retryAfterMs ?? (verdict.resetAt !== undefined ? Math.max(0, verdict.resetAt - now()) : undefined)
        : undefined;
      const waitMs = hintMs ?? Math.min(RETRY_CAP_MS, baseBackoffMs * 2 ** (attempt - 1));
      if (totalWaited + waitMs > maxWaitMs) return { ok: false, error: verdict };
      totalWaited += waitMs;
      if (verdict.accountWide) {
        deps.governor.penalize({ retryAfterMs: waitMs }); // shared pause; next acquire waits
      } else {
        backoffMs = waitMs; // per-call local backoff
      }
    } finally {
      release();
    }
    if (backoffMs > 0) await sleep(backoffMs);
  }
  return { ok: false, error: last ?? { retryable: false, accountWide: false, message: 'exhausted attempts' } };
}
