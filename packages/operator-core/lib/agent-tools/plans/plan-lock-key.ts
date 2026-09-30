import type { Sql, TransactionSql } from 'postgres';
import { createDedicatedOrgPg, withDbCallDeadline } from '@papercusp/db-org';

/** Shared identity for the transaction-scoped advisory lock protecting one plan. */
export const PLAN_ADVISORY_LOCK_NAMESPACE = 'harness_plans';

export function planAdvisoryLockKey(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): string {
  return `${workspaceId}:${harnessSlug}:${planSlug}`;
}

/** PG error raised when a statement is canceled by `lock_timeout`. */
export const PLAN_LOCK_TIMEOUT_CODE = '55P03';

/** Default acquisition budget for the plan advisory lock, in ms. */
export const PLAN_ADVISORY_LOCK_BUDGET_MS = 5_000;

/** Keep post-rollback diagnostics shorter than the lock acquisition budget. */
export const PLAN_LOCK_SNAPSHOT_BUDGET_MS = 1_000;

/**
 * Point-in-time PostgreSQL metadata observed after a timed-out plan-lock
 * transaction has rolled back. This is deliberately not a coordination owner
 * record: the backend may disappear or change before the caller receives it.
 */
export interface PlanLockHolderSnapshot {
  captured_at: string;
  lock_key: string;
  holders: Array<{
    pid: number;
    application_name: string | null;
    state: string | null;
    query_start: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
  }>;
}

/**
 * Either client that takes this lock: `withPlanLock` runs inside `withWorkspace`'s `Sql`, and the
 * dependency-admission wrapper accepts a `TransactionSql` (and test tagged-SQL shims).
 */
export type PlanAdvisoryLockSql = Sql | TransactionSql;

/**
 * Best-effort, bounded holder diagnostics for a plan advisory key.
 *
 * This MUST run on a fresh admin client: the transaction that raised 55P03 is
 * aborted and cannot safely execute another statement. The result is only a
 * point-in-time `pg_locks`/`pg_stat_activity` observation; callers must retain
 * the durable owner/expiry values as unknown/null.
 */
export async function readPlanAdvisoryLockSnapshot(
  lockKey: string,
  budgetMs: number = PLAN_LOCK_SNAPSHOT_BUDGET_MS,
): Promise<PlanLockHolderSnapshot | null> {
  const capMs = Math.max(1, Math.floor(budgetMs));
  let client: ReturnType<typeof createDedicatedOrgPg> | null = null;
  try {
    client = createDedicatedOrgPg('plan-lock-snapshot', { max: 1 });
    const rows = await withDbCallDeadline(
      client.sql<
        Array<{
          pid: number | string;
          application_name: string | null;
          state: string | null;
          query_start: string | null;
          wait_event_type: string | null;
          wait_event: string | null;
        }>
      >`
        SELECT l.pid,
               a.application_name,
               a.state,
               a.query_start::text AS query_start,
               a.wait_event_type,
               a.wait_event
         FROM pg_locks AS l
          LEFT JOIN pg_stat_activity AS a ON a.pid = l.pid
         WHERE l.locktype = 'advisory'
           AND l.objsubid = 2
           AND l.database = (
             SELECT oid
               FROM pg_database
              WHERE datname = current_database()
           )
           AND l.classid::bigint = (hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE})::bigint & 4294967295)
           AND l.objid::bigint = (hashtext(${lockKey})::bigint & 4294967295)
           AND l.granted
         ORDER BY l.pid
      `,
      { ms: capMs, label: 'plans:advisory-lock-snapshot' },
    );

    return {
      captured_at: new Date().toISOString(),
      lock_key: lockKey,
      holders: rows.flatMap((row) => {
        const pid = Number(row.pid);
        return Number.isSafeInteger(pid)
          ? [{
              pid,
              application_name: row.application_name ?? null,
              state: row.state ?? null,
              query_start: row.query_start ?? null,
              wait_event_type: row.wait_event_type ?? null,
              wait_event: row.wait_event ?? null,
            }]
          : [];
      }),
    };
  } catch {
    // Diagnostics are strictly best-effort. A failed fresh connection/query
    // must never turn a safe busy response into a second failure.
    return null;
  } finally {
    try {
      await client?.sql.end({ timeout: 1 });
    } catch {
      // The diagnostic client is caller-owned and disposable; close failures
      // must not mask the original busy result.
    }
  }
}

/**
 * The one way to take a plan's advisory lock — a BOUNDED BLOCKING acquire (WI-2143102).
 *
 * Both writers of `harness_plans` key on `(hashtext('harness_plans'), hashtext(<plan key>))`, and
 * before this they took it two incompatible ways, which is a starvation machine rather than a
 * fairness accident:
 *
 *   - `withPlanLock` polled `pg_try_advisory_xact_lock` every 50ms against a ~5s budget. A TRY
 *     acquire never joins the lock's wait queue.
 *   - `withPlanDependencyAdmissionTransaction` took the blocking `pg_advisory_xact_lock`, and
 *     `withWorkspace` sets no `lock_timeout`, so it waited without any bound at all.
 *
 * PostgreSQL hands a released lock straight to the head of its WAIT QUEUE. So while even one
 * blocking waiter is queued, the lock is never observably free to a poller: the holder's COMMIT
 * and the next grant are one atomic step, with no window for a `try` to land in. The poller is
 * therefore starved BY CONSTRUCTION — not unlucky — no matter how long its budget, while the
 * blocking waiters pin one org-app pool connection each for as long as the convoy lasts.
 * Measured 2026-09-03 02:33–02:40Z on `byoc-cloud-workspaces-gcp-aws-azure-2026-08-22`: 18–21
 * operator backends continuously queued on that exact key, oldest waiter 59 minutes, and the plan
 * row's `updated_at` an hour stale — a full hour of total contention that committed nothing.
 *
 * So both callers now come through here and get the SAME discipline: JOIN the queue (fair, and
 * the grant cannot be missed) with a BOUND (a waiter can never pin a pooled connection
 * indefinitely). The cap is `SET LOCAL`, so it dies with the transaction and can never leak onto
 * the pooled connection, and it is reset once the lock is held — it bounds the ACQUISITION, never
 * whatever the caller does while holding it, which is the pre-existing behaviour.
 *
 * On timeout this THROWS the PG `55P03`; it deliberately does not swallow it, because a
 * lock_timeout aborts the transaction and no further statement could run in it anyway. Catch it
 * OUTSIDE the transaction (as `withPlanLock` does, converting it to `busy`).
 */
export async function acquirePlanAdvisoryLock(
  tx: PlanAdvisoryLockSql,
  lockKey: string,
  budgetMs: number = PLAN_ADVISORY_LOCK_BUDGET_MS,
): Promise<void> {
  const capMs = Math.max(1, Math.floor(budgetMs));
  await tx`SELECT set_config('lock_timeout', ${String(capMs)}, true)`;
  await tx`
    SELECT pg_advisory_xact_lock(hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}), hashtext(${lockKey}))
  `;
  // Held. Restore the un-capped wait for the rest of the transaction — these transactions
  // carried no lock_timeout before this change, and re-using the acquisition cap as a general
  // statement cap would be a second, unrelated behaviour change smuggled in with this one.
  await tx`SELECT set_config('lock_timeout', '0', true)`;
}
