/**
 * Postgres retryable-transaction-failure predicates — the ONE definition of
 * "this migration failure is contention, ride it out" shared by every path
 * that applies migrations.
 *
 * WHY THIS MODULE EXISTS (EI-19320461261471579). These predicates were born
 * inside `agent-tools/db/migrate.ts` (the db:migrate TOOL) for EI-9417 and
 * EI-18747087108453188. But there are TWO paths that apply migrations on this
 * box, and only one of them is that tool:
 *
 *   1. `db:migrate`            — an agent applies a migration BY HAND.
 *   2. `db-boot-migrate.ts`    — the operator applies pending migrations
 *                                AUTOMATICALLY, at boot AND as the
 *                                green-checkpoint gate's migration preflight.
 *
 * The deadlock-retry fix landed in (1) and never reached (2) — so a deadlock in
 * the gate's preflight left the migration pending and the gate aborted the run
 * as INCONCLUSIVE (`green: null`, `reason: 'migrations-pending'`), holding main
 * for the whole fleet. Observed live twice in 11 minutes on 2026-08-02
 * (05:50Z, 06:01Z) on migration 721.
 *
 * The predicates live HERE, dependency-free, rather than being imported from
 * migrate.ts, because migrate.ts pulls in `@papercusp/agent-mcp`, the lock
 * store, and the escalation surface — far too heavy for a boot path. Copying
 * the regexes into the second site would have re-created the exact drift this
 * item is about: a fix applied to one copy and not the other. migrate.ts now
 * re-exports these, so its existing importers and tests are unchanged.
 */

/** True iff `stderr` is PG's own "canceling statement due to lock timeout"
 *  (SQLSTATE 55P03). Pure — unit tested via migrate.test.ts. */
export function isLockTimeoutFailure(stderr: string): boolean {
  return /canceling statement due to lock timeout/i.test(stderr);
}

/** True iff `stderr` is PG's own "deadlock detected" (SQLSTATE 40P01).
 *  EI-18747087108453188: a deadlock is if anything MORE retryable than a lock
 *  timeout — Postgres has already broken the cycle by killing one side of it,
 *  so an immediate retry usually succeeds — and it is the MORE LIKELY failure
 *  on this box: any migration touching harness_shared.work_items also touches
 *  its two dependent views (engineer_issues, harness_features_consolidated),
 *  and a reader locks view-then-base while `ALTER TABLE …; CREATE OR REPLACE
 *  VIEW …` locks base-then-view — a guaranteed lock-order inversion against
 *  ordinary fleet read traffic that fires readily on a 122-agent box. Pure. */
export function isDeadlockFailure(stderr: string): boolean {
  return /deadlock detected/i.test(stderr);
}

/** True iff `stderr` is PG's own serialization-failure cancel (SQLSTATE 40001 —
 *  "could not serialize access due to concurrent update" / "...due to
 *  read/write dependencies among transactions"), the third member of PG's
 *  retryable-transaction-error family alongside lock timeout and deadlock.
 *  Pure. */
export function isSerializationFailure(stderr: string): boolean {
  return /could not serialize access/i.test(stderr);
}

/** True iff `stderr` is ANY of the retryable transaction-contention failure
 *  classes a migration apply may ride out with backoff: lock timeout, deadlock,
 *  or serialization failure. Any other error (syntax, constraint, …) is a
 *  genuine defect and must fail immediately, unretried. Pure. */
export function isRetryableLockFailure(stderr: string): boolean {
  return isLockTimeoutFailure(stderr) || isDeadlockFailure(stderr) || isSerializationFailure(stderr);
}

export const LOCK_RETRY_BASE_DELAY_MS = 2000;
export const LOCK_RETRY_MAX_DELAY_MS = 30_000;

/** Exponential backoff (2s, 4s, 8s, 16s, capped at 30s) for attempt N
 *  (1-based) — gives the hot table's writers a window to quiesce between
 *  attempts. Pure + unit tested. */
export function lockRetryBackoffMs(attempt: number): number {
  return Math.min(LOCK_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), LOCK_RETRY_MAX_DELAY_MS);
}
