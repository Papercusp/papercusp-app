/**
 * Shared retry-with-backoff for PG-backed lock acquisitions that hit a TRANSIENT
 * contention timeout (pg 55P03 lock_timeout / 57014 statement_timeout) under box
 * load.
 *
 * EI-1720 (git-sync stalls) + the worker-fire-path zombie-spawn / bee file-lock
 * fail-opens all share one root cause: under high load the workspace
 * `pg_advisory_xact_lock` acquire (inWorkspaceTxn, 5s) times out, and call sites
 * that SKIP the tick / FAIL OPEN on that single timeout stall git-sync or bypass
 * file-locking. Retrying the acquire a few times rides out the contention dip
 * (the lock self-recovers once load eases) instead of giving up on one timeout.
 * Non-contention errors are NOT retried — a real bug / DB-down must surface
 * immediately.
 */

/**
 * True for the PG contention SQLSTATEs (lock_timeout 55P03 / statement_timeout
 * 57014) that mean "couldn't serialize in time" — transient under load, safe to
 * retry. Matched by `WorkspaceContendedError`'s `name` + `pgCode` (or a raw pg
 * `code`) so callers needn't import the locks-package error type.
 */
export function isWorkspaceContended(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { name?: string; pgCode?: string; code?: string; retryable?: unknown };
  return (
    o.name === 'WorkspaceContendedError' ||
    o.pgCode === '57014' || o.pgCode === '55P03' ||
    o.code === '57014' || o.code === '55P03' ||
    // EI-22803020855465174: a bounded read (`boundedPgReadTxn` / `boundedOrgTxn`) that
    // could not ACQUIRE a pool connection within its deadline throws a
    // `DbCallDeadlineError`, not a PG SQLSTATE — so the acceptance-grading sweep's
    // `reconcilePendingGradingAudits` was rethrowing it on attempt 0 and leaving its
    // scorecards pending with zero auditors. The error carries the pool's OWN verdict:
    // `retryable` is true only when this process measured a recent successful
    // acquisition or a client-side saturation/queue verdict (a saturated-but-healthy
    // pool = the same transient-under-load class as 55P03). An unmeasured/stale pool
    // may be a dead endpoint, so those deadlines stay non-retryable and surface at once.
    (o.name === 'DbCallDeadlineError' && o.retryable === true)
  );
}

/** Backoffs (ms) between lock-acquire retries — ~6s total over 3 retries: long
 *  enough to ride out a transient contention dip, short enough not to hold a
 *  background tick / fleet spawn for long. */
export const LOCK_CONTENTION_BACKOFFS_MS = [500, 1500, 4000] as const;

/**
 * Run `run()`; on a TRANSIENT workspace-lock contention (pg 57014/55P03) back off
 * and retry, up to `backoffsMs.length` times. Non-contention errors propagate
 * immediately. Backoff + sleep are injectable for tests.
 */
export async function acquireWithContentionRetry<T>(
  run: () => Promise<T>,
  opts: { backoffsMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const backoffs = opts.backoffsMs ?? LOCK_CONTENTION_BACKOFFS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (!isWorkspaceContended(e)) throw e;
      lastErr = e;
      if (attempt >= backoffs.length) throw lastErr;
      await sleep(backoffs[attempt]);
    }
  }
}
