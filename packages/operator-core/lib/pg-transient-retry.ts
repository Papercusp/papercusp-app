/**
 * pg-transient-retry — a small bounded retry for BEST-EFFORT background DB ops
 * that must survive a *transient, self-recovering* postgres-js connect blip
 * without logging a hard failure.
 *
 * ## Why this exists (WI-2776)
 *
 * On the busy multi-agent bg-host, momentary event-loop stalls (the loop-governor
 * ramps concurrency down under lag, then back up) let in-flight DB transactions
 * cross `idle_in_transaction_session_timeout` and get killed in bursts. The pool
 * churns, and the postgres.js pool's `connect()` to PgBouncer (:6432) then exceeds
 * `connect_timeout` and rejects with code `CONNECT_TIMEOUT` ("write CONNECT_TIMEOUT
 * 127.0.0.1:6432"). The pool reconnects on the very next query, so the condition is
 * transient and self-healing — but the handful of best-effort background sweeps that
 * issue the failing query (drainSentinelSays, the await-event sweeper, pipeline-events
 * summarize, the hive survey's plan read) had NO resilience: they caught the error and
 * logged a hard failure on every blip, producing the CONNECT_TIMEOUT log cluster.
 *
 * A bounded retry absorbs the transient: because a `CONNECT_TIMEOUT` fires in the
 * connect phase, the query was queued but PROVABLY never reached the server, so it is
 * safe to retry even a *mutating* statement (nothing was applied). The retry's backoff
 * also naturally DEFERS the re-attempt past the event-loop stall — a `setTimeout`
 * cannot fire until the loop unblocks, by which point the pool has reconnected — so the
 * re-attempt lands on a healthy connection. A GENUINELY sustained outage still exhausts
 * the retries and surfaces at the call site's existing catch (we rethrow, never
 * swallow), so this narrows the log to real, persistent problems instead of masking
 * them.
 *
 * ## Scope — retry-SAFE, deliberately narrower than the process-guard classifier
 *
 * `isTransientPgConnectionError` in `packages/operator-core/lib/host-benign-errors.ts` decides
 * whether a process-level error is *non-fatal to the multi-tenant host* (keep serving,
 * don't crash-loop) — it is broad on purpose (CONNECT_TIMEOUT | CONNECTION_CLOSED |
 * the detached null-`write` TypeError). That is the WRONG predicate for a RETRY: on
 * `CONNECTION_CLOSED` (or the null-write flush crash) a query may have partially run,
 * so blindly re-issuing a mutating statement could double-apply or lose data. This
 * module therefore uses its own strictly-narrower `isRetriablePgConnectError`
 * (CONNECT_TIMEOUT only = connect phase = provably pre-execution). The two classifiers
 * are independent concerns that merely overlap; coupling them would be false DRY.
 * CONNECT_TIMEOUT is also the only class actually observed in the WI-2776 cluster.
 */

/**
 * True iff `e` is a postgres-js connect-phase timeout (`CONNECT_TIMEOUT`): the pool's
 * `connect()` exceeded `connect_timeout`, so any queued query never reached the server
 * and is SAFE to retry (even a mutating one). Strictly narrower than the host-guard's
 * `isTransientPgConnectionError` — see the module header for why retry must not treat
 * `CONNECTION_CLOSED` / the null-write crash as retriable.
 */
export function isRetriablePgConnectError(e: unknown): boolean {
  const x = e as { code?: string; message?: string } | null;
  if (!x) return false;
  // `CONNECT_TIMEOUT` is a postgres-js-invented code (not a Node errno), so matching on
  // it is inherently postgres-js-scoped and cannot mask an unrelated error.
  return x.code === 'CONNECT_TIMEOUT' || /\bCONNECT_TIMEOUT\b/.test(x.message ?? '');
}

/**
 * True iff `e` is a postgres-js connection-loss error that is retry-safe **for a caller
 * that has independently established its operation is idempotent**: `CONNECT_TIMEOUT`
 * (provably pre-execution — see {@link isRetriablePgConnectError}) PLUS the codes
 * postgres-js raises when the pool a caller is holding is torn down underneath it —
 * `CONNECTION_DESTROYED`, `CONNECTION_CLOSED`, `CONNECTION_ENDED`.
 *
 * ## Why this is separate, and deliberately NOT the default
 *
 * Those three codes do **not** prove the statement never reached the server.
 * `CONNECTION_DESTROYED` in particular is raised from two structurally different places:
 * `connection.js`'s `execute()` guard, which fires *before a single byte is written* (so
 * the query provably never ran), and `terminate()`/`destroy()`, which reject queries that
 * were already in flight. The two are indistinguishable from the error alone — only the
 * stack separates them, and a stack line number is exactly the kind of derived truth that
 * rots on the next postgres-js bump. So this classifier cannot be used to make a
 * *mutating* call site safe; the CALLER has to be idempotent on its own terms.
 *
 * {@link isRetriablePgConnectError} therefore stays the default for background sweeps.
 * Pass this one only where re-running the whole operation is known-harmless, and say why
 * at the call site.
 *
 * Real case this exists for (WI-10001781): the release cut's seed phase lost a connection
 * between two reads and aborted the whole cut. Its only mutation is an append-only
 * `substrate_outbox` enqueue that carries no uniqueness constraint, and the drain re-applies
 * a duplicate `put` idempotently under LWW — so a repeat costs drain time, never
 * correctness. That is the shape this predicate is for.
 */
export function isRetriableIdempotentPgConnectionError(e: unknown): boolean {
  if (isRetriablePgConnectError(e)) return true;
  const x = e as { code?: string; message?: string } | null;
  if (!x) return false;
  // All three are postgres-js-invented codes (not Node errnos), so matching them is
  // inherently postgres-js-scoped and cannot mask an unrelated error.
  const codes = /\b(CONNECTION_DESTROYED|CONNECTION_CLOSED|CONNECTION_ENDED)\b/;
  return codes.test(x.code ?? '') || codes.test(x.message ?? '');
}

export interface PgRetryOpts {
  /** Additional attempts AFTER the first (so total tries = retries + 1). Default 2. */
  retries?: number;
  /** Base backoff in ms; grows linearly per attempt (backoffMs * attemptNumber). Default 200. */
  backoffMs?: number;
  /**
   * Predicate deciding whether a caught error is worth retrying. Default
   * `isRetriablePgConnectError` (CONNECT_TIMEOUT only). Read-only call sites MAY pass a
   * broader predicate; mutating call sites should keep the default.
   */
  classifier?: (e: unknown) => boolean;
  /** Optional label for observability hooks (not logged here — the call site owns logging). */
  label?: string;
  /** Called just before each scheduled retry (attempt is 1-based). Test/observability hook. */
  onRetry?: (attempt: number, e: unknown) => void;
  /** Injectable sleep (tests pass a synchronous stub). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying up to `retries` times on a classified transient error. Rethrows
 * the LAST error once retries are exhausted (or immediately for a non-classified error)
 * so the caller's existing catch still runs — this helper NEVER swallows.
 */
export async function withPgRetry<T>(fn: () => Promise<T>, opts: PgRetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 200;
  const classify = opts.classifier ?? isRetriablePgConnectError;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // Out of budget, or not a transient we should retry → propagate to the caller.
      if (attempt >= retries || !classify(e)) throw e;
      opts.onRetry?.(attempt + 1, e);
      await sleep(backoffMs * (attempt + 1));
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies the type checker.
  throw lastErr;
}
