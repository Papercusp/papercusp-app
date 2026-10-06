/**
 * One-round-trip shared-semaphore operations on named resources (sql/030).
 *
 * papercusp-log-performance-remediation-2026-09-23 P-014(e), WI-10004964.
 * `inWorkspaceTxn` holds the exclusive domain key for the whole client-driven
 * transaction: BEGIN, set_config, the lock, then each store statement, then
 * COMMIT, every hop waiting on the caller's event loop. Measured 2026-10-01:
 * 543k domain-key waits at a 35 ms mean while every guarded statement averaged
 * under 1 ms. The waiters were a hot shared semaphore contending with itself
 * across busy operator workers.
 *
 * Each function here is ONE autocommit statement calling a plpgsql function.
 * That function takes the shared domain gate plus an exclusive per-resource key
 * and does the whole operation server-side. The locks are released when the
 * statement ends, so they are held for server time only, and other resources in
 * the domain proceed concurrently. A domain-global operation still holds the
 * exclusive domain key and so still serializes against these.
 *
 * Shared mode only. Exclusive acquire/release (fencing, FIFO queue, targeted
 * back-up broadcast) stays on the transactional store API. The admission rules
 * are the SAME function tryAcquireResource's shared branch calls.
 */

import { txnTimeouts } from './config';
import { RESOURCE_WAITER_TTL_SEC, type SharedAcquireRpcResult } from './resource-lock-store';
import { ensureBootstrap, getTxPool, SU_LOCKS_FEATURE_KEY } from './su-lock-store';

export interface AtomicSharedAcquireParams {
  coordinationDomain: string;
  resource: string;
  owner: string;
  ownerLabel: string | null;
  reason: string;
  ttlSec: number;
  /** Advisory-lock wait ceiling for this one statement. Defaults to the live
   *  db:txn-timeouts lock timeout (the same ceiling inWorkspaceTxn applies). */
  lockTimeoutMs?: number;
}

export type AtomicSharedAcquireResult =
  | { ok: true; lock_id: string; expires_ts: Date }
  | { ok: false; reason: Extract<SharedAcquireRpcResult, { ok: false }>['reason'] };

export interface AtomicSharedLeaseParams {
  coordinationDomain: string;
  resource: string;
  owner: string;
  lockId: string;
  lockTimeoutMs?: number;
}

function lockTimeout(ms: number | undefined): number {
  if (ms != null && Number.isFinite(ms) && ms > 0) return Math.trunc(ms);
  return Math.trunc(txnTimeouts().lockTimeoutMs);
}

/** Acquire (or renew) a shared hold in one statement. */
export async function acquireSharedResourceAtomic(
  params: AtomicSharedAcquireParams,
): Promise<AtomicSharedAcquireResult> {
  await ensureBootstrap();
  const sql = getTxPool();
  const [row] = await sql<Array<{ result: SharedAcquireRpcResult }>>`
    SELECT resource_acquire_shared(
      ${SU_LOCKS_FEATURE_KEY}::integer, ${params.coordinationDomain}, ${params.resource},
      ${params.owner}, ${params.ownerLabel}, ${params.reason}, ${params.ttlSec}::integer,
      ${RESOURCE_WAITER_TTL_SEC}::integer, true, ${lockTimeout(params.lockTimeoutMs)}::integer
    ) AS result
  `;
  const result = row.result;
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, lock_id: result.lock_id, expires_ts: new Date(result.expires_ts) };
}

/** Extend a live shared lease in one statement. `extended:false` = it had
 *  already expired (and was swept) or is not this owner's shared lease. */
export async function heartbeatSharedResourceAtomic(
  params: AtomicSharedLeaseParams & { ttlSec: number },
): Promise<{ extended: boolean; expires_ts: Date | null }> {
  await ensureBootstrap();
  const sql = getTxPool();
  const [row] = await sql<Array<{ expires_ts: Date | null }>>`
    SELECT resource_heartbeat_shared(
      ${SU_LOCKS_FEATURE_KEY}::integer, ${params.coordinationDomain}, ${params.resource},
      ${params.owner}, ${params.lockId}::uuid, ${params.ttlSec}::integer,
      ${lockTimeout(params.lockTimeoutMs)}::integer
    ) AS expires_ts
  `;
  const expires = row.expires_ts;
  return expires == null ? { extended: false, expires_ts: null } : { extended: true, expires_ts: new Date(expires) };
}

/** Release one shared lease in one statement, completing any exclusive drain
 *  it was the last obstacle to. `expired:true` = the lease lapsed before the
 *  release reached it (the caller's work outlived its TTL). */
export async function releaseSharedResourceAtomic(
  params: AtomicSharedLeaseParams,
): Promise<{ released: number; expired: boolean }> {
  await ensureBootstrap();
  const sql = getTxPool();
  const [row] = await sql<Array<{ result: { released: number; expired: boolean } }>>`
    SELECT resource_release_shared(
      ${SU_LOCKS_FEATURE_KEY}::integer, ${params.coordinationDomain}, ${params.resource},
      ${params.owner}, ${params.lockId}::uuid, ${lockTimeout(params.lockTimeoutMs)}::integer
    ) AS result
  `;
  return { released: Number(row.result.released), expired: row.result.expired === true };
}
