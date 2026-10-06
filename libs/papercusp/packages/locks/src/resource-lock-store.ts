/**
 * Named resource locks — storage layer (plan named-resource-locks-drain).
 *
 * A *named resource* (registered in agent_resource_registry) supports MANY
 * concurrent `shared` holders + at most ONE `exclusive` holder, gated by a
 * writer-priority drain: a pending exclusive refuses NEW shared acquires
 * but lets existing ones finish, then is granted once they drain to zero.
 *
 * This is a SEPARATE table from agent_file_locks (D-001/D-009): shared mode
 * breaks the file-lock (domain,path) PK, and that table is the safety-
 * critical hot path. We reuse the same papercusp_su db, the same
 * ch_coord_<domain> NOTIFY channel, and the same inWorkspaceTxn advisory
 * lock; the drain cascade (resource_grant_cascade) mirrors grant_cascade.
 *
 * Like su-lock-store, these helpers take a `tx: Sql` and run inside the
 * caller's inWorkspaceTxn — they never touch the pool directly. Read-only
 * helpers (status / queue / registry reads) take a plain Sql (the pool).
 */

import type { Sql } from 'postgres';

export type ResourceMode = 'shared' | 'exclusive';
export type ResourceLockStatus = 'held' | 'draining';
export type ResourceEnforcement = 'advisory' | 'checked' | 'enforced';

export interface ResourceHolder {
  /** Named resource this holder row belongs to (present for scoped and unscoped reads). */
  resource: string;
  owner: string;
  owner_label: string | null;
  mode: ResourceMode;
  status: ResourceLockStatus;
  lock_id: string;
  reason: string;
  acquired_ts: Date;
  expires_ts: Date;
  /** Monotonic fencing token stamped when this exclusive became effective
   *  ('held'). 0 for shared rows and for an exclusive still 'draining'. (D-001) */
  fence_seq: number;
}

export interface ResourceRegistryRow {
  resource: string;
  description: string;
  rule_text: string;
  enforcement: ResourceEnforcement;
  match_patterns: string[];
  /** Counting-semaphore capacity for shared holders (D-008). null = unbounded. */
  max_holders: number | null;
}

export interface ResourceAcquireParams {
  coordinationDomain: string;
  resource: string;
  mode: ResourceMode;
  owner: string;
  ownerLabel: string | null;
  reason: string;
  ttlSec: number;
  /**
   * Keep a refused exclusive request in the durable FIFO queue. Callers that
   * return a terminal conflict must leave this false; otherwise the cascade
   * can grant a lease after the caller has already stopped waiting.
   */
  queueOnConflict?: boolean;
}

/** A pending exclusive request. Queue rows are requests, not leases. */
export interface ResourceExclusiveQueueEntry {
  ticket_id: string;
  resource: string;
  owner: string;
  owner_label: string | null;
  reason: string;
  ttl_sec: number;
  queued_ts: Date;
  expires_ts: Date;
}

/** How long an exclusive request may remain queued before it is abandoned. */
const EXCLUSIVE_QUEUE_TTL_SEC = 30 * 60;

export type ResourceAcquireResult =
  | {
      ok: true;
      lock_id: string;
      mode: ResourceMode;
      /** 'held' = granted now; 'draining' = exclusive accepted, waiting on
       *  shared holders to drain before it is effective. */
      status: ResourceLockStatus;
      expires_ts: Date;
      /** Live shared holders at acquire time (the set an exclusive must
       *  wait to drain; empty for a granted exclusive / a shared acquire). */
      shared_holders: ResourceHolder[];
      /** Monotonic fencing token (D-001). Non-zero only for an exclusive that
       *  is effective NOW (status 'held'); 0 for shared and for a 'draining'
       *  exclusive (its fence is minted by the cascade on the flip to 'held'). */
      fence_seq: number;
    }
  | {
      ok: false;
      reason:
        | 'unknown_resource' // not in the registry (D-010)
        | 'exclusive_pending' // shared blocked by a held/draining exclusive (writer-priority)
        | 'holds_shared' // exclusive blocked by the caller's own shared lease (no upgrade, D-004)
        | 'held_exclusive' // exclusive held by another owner (or caller already holds exclusive)
        | 'at_capacity'; // shared blocked: the resource's max_holders semaphore is full (D-008)
      holders: ResourceHolder[];
      /** Stable request ticket when this exclusive was queued behind another. */
      queue_ticket?: string;
      /** One-based position among the live requests for this resource. */
      queue_position?: number;
    };

/** jsonb returned by resource_acquire_shared (sql/030). jsonb carries
 *  timestamptz as an ISO string, so callers convert expires_ts to a Date. */
export type SharedAcquireRpcResult =
  | { ok: true; lock_id: string; expires_ts: string }
  | { ok: false; reason: 'unknown_resource' | 'exclusive_pending' | 'at_capacity' | 'held_exclusive' };

async function readLiveExclusiveQueue(
  sql: Sql,
  coordinationDomain: string,
  resource?: string,
): Promise<ResourceExclusiveQueueEntry[]> {
  return resource
    ? sql<ResourceExclusiveQueueEntry[]>`
        SELECT ticket_id::text AS ticket_id, resource, owner, owner_label, reason,
               ttl_sec, queued_ts, expires_ts
          FROM agent_resource_exclusive_queue
         WHERE coordination_domain = ${coordinationDomain}
           AND resource = ${resource}
           AND expires_ts > clock_timestamp()
         ORDER BY queued_ts ASC, ticket_id ASC
      `
    : sql<ResourceExclusiveQueueEntry[]>`
        SELECT ticket_id::text AS ticket_id, resource, owner, owner_label, reason,
               ttl_sec, queued_ts, expires_ts
          FROM agent_resource_exclusive_queue
         WHERE coordination_domain = ${coordinationDomain}
           AND expires_ts > clock_timestamp()
         ORDER BY resource ASC, queued_ts ASC, ticket_id ASC
      `;
}

/**
 * Enqueue (or refresh) an exclusive request without moving it to the back of
 * the line. The unique owner key makes retries idempotent; queued_ts remains
 * the original admission time while the lease metadata and abandonment TTL
 * are refreshed.
 */
export async function enqueueResourceExclusive(
  tx: Sql,
  params: {
    coordinationDomain: string;
    resource: string;
    owner: string;
    ownerLabel: string | null;
    reason: string;
    ttlSec: number;
  },
): Promise<ResourceExclusiveQueueEntry> {
  const { coordinationDomain, resource, owner, ownerLabel, reason, ttlSec } = params;
  const queueTtlText = `${EXCLUSIVE_QUEUE_TTL_SEC} seconds`;
  const rows = await tx<ResourceExclusiveQueueEntry[]>`
    INSERT INTO agent_resource_exclusive_queue
      (coordination_domain, resource, owner, owner_label, reason, ttl_sec, expires_ts)
    VALUES
      (${coordinationDomain}, ${resource}, ${owner}, ${ownerLabel}, ${reason}, ${ttlSec},
       clock_timestamp() + ${queueTtlText}::interval)
    ON CONFLICT (coordination_domain, resource, owner) DO UPDATE
      SET owner_label = EXCLUDED.owner_label,
          reason      = EXCLUDED.reason,
          ttl_sec     = EXCLUDED.ttl_sec,
          expires_ts  = EXCLUDED.expires_ts
    RETURNING ticket_id::text AS ticket_id, resource, owner, owner_label, reason,
              ttl_sec, queued_ts, expires_ts
  `;
  return rows[0];
}

/** Remove a caller's pending request after it has been admitted. */
export async function clearResourceExclusiveQueue(
  tx: Sql,
  coordinationDomain: string,
  resource: string,
  owner: string,
): Promise<void> {
  await tx`
    DELETE FROM agent_resource_exclusive_queue
     WHERE coordination_domain = ${coordinationDomain}
       AND resource = ${resource}
       AND owner = ${owner}
  `;
}

/** Remove abandoned requests and return how many queue tickets were collected. */
export async function sweepResourceExclusiveQueue(
  tx: Sql,
  coordinationDomain: string,
): Promise<number> {
  const rows = await tx<Array<{ ticket_id: string }>>`
    DELETE FROM agent_resource_exclusive_queue
     WHERE coordination_domain = ${coordinationDomain}
       AND expires_ts <= clock_timestamp()
    RETURNING ticket_id::text AS ticket_id
  `;
  return rows.length;
}

/** Run the SQL head-admission cascade for this coordination domain. */
export async function promoteResourceExclusiveQueue(
  tx: Sql,
  coordinationDomain: string,
): Promise<void> {
  await tx`SELECT resource_grant_cascade(${coordinationDomain}, clock_timestamp())`;
}

function queuePosition(queue: ResourceExclusiveQueueEntry[], ticketId: string): number | undefined {
  const index = queue.findIndex((entry) => entry.ticket_id === ticketId);
  return index < 0 ? undefined : index + 1;
}

async function readLiveHolders(
  tx: Sql,
  coordinationDomain: string,
  resource: string,
): Promise<ResourceHolder[]> {
  return tx<ResourceHolder[]>`
    SELECT resource, owner, owner_label, mode, status, lock_id::text AS lock_id, reason,
           acquired_ts, expires_ts, fence_seq::int AS fence_seq
      FROM agent_resource_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND resource = ${resource}
       AND expires_ts > clock_timestamp()
     ORDER BY acquired_ts ASC
  `;
}

/**
 * Delete this workspace's expired resource-lock rows and queue tickets.
 * Mirrors sweepWorkspaceExpired for the file locks — drain-to-zero relies
 * on expired shared holders being removed so resource_grant_cascade can fire.
 *
 * Resource waiters are deliberately not swept here. They are a notification
 * ledger, not an admission input, so deleting them from acquire/release/
 * heartbeat transactions adds avoidable write contention to the hot path.
 * The background janitor owns their expiry GC instead.
 *
 * Returns true if anything affecting admission was swept (so the caller can
 * run the cascade).
 */
export async function sweepResourceExpired(
  tx: Sql,
  coordinationDomain: string,
): Promise<boolean> {
  const rows = await tx<Array<{ resource: string }>>`
    DELETE FROM agent_resource_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND expires_ts <= clock_timestamp()
    RETURNING resource
  `;
  const queueRows = await sweepResourceExclusiveQueue(tx, coordinationDomain);
  return rows.length > 0 || queueRows > 0;
}

/** Delete abandoned resource waiter rows for one coordination domain.
 * This is background-maintenance work only; waiter rows do not affect
 * resource admission and must not be deleted by the hot-path sweep above.
 */
export async function sweepResourceWaitersExpired(
  tx: Sql,
  coordinationDomain: string,
): Promise<number> {
  const rows = await tx<Array<{ owner: string }>>`
    DELETE FROM agent_resource_waiters
     WHERE coordination_domain = ${coordinationDomain}
       AND expires_ts <= clock_timestamp()
    RETURNING owner
  `;
  return rows.length;
}

// ───────── Waiter ledger (A4 — targeted "resource back up" broadcast) ─────────
// A refused acquirer (blocked by another owner's exclusive) is recorded here so
// the back-up broadcast on release can target just the waiters, not ['*'].

/** How long a refused acquirer stays a "waiter" before it's GC'd as abandoned.
 *  Exported because resource_acquire_shared (sql/030) records waiters too and
 *  takes this TTL as an argument rather than restating it in SQL. */
export const RESOURCE_WAITER_TTL_SEC = 30 * 60;
const WAITER_TTL_SEC = RESOURCE_WAITER_TTL_SEC;

/** Record `owner` as waiting on `resource` (refused while an exclusive was held). */
export async function recordResourceWaiter(
  tx: Sql,
  params: { coordinationDomain: string; resource: string; owner: string; ownerLabel: string | null },
): Promise<void> {
  const { coordinationDomain: cd, resource, owner, ownerLabel } = params;
  const ttlText = `${WAITER_TTL_SEC} seconds`;
  await tx`
    INSERT INTO agent_resource_waiters (coordination_domain, resource, owner, owner_label, expires_ts)
    VALUES (${cd}, ${resource}, ${owner}, ${ownerLabel}, clock_timestamp() + ${ttlText}::interval)
    ON CONFLICT (coordination_domain, resource, owner) DO UPDATE
      SET owner_label = EXCLUDED.owner_label,
          queued_ts   = clock_timestamp(),
          expires_ts  = EXCLUDED.expires_ts
  `;
}

/** Drop `owner`'s waiter row for `resource` — they just acquired it. */
export async function clearResourceWaiter(
  tx: Sql,
  coordinationDomain: string,
  resource: string,
  owner: string,
): Promise<void> {
  await tx`
    DELETE FROM agent_resource_waiters
     WHERE coordination_domain = ${coordinationDomain} AND resource = ${resource} AND owner = ${owner}
  `;
}

/** Read + delete every live waiter on `resource` — the back-up broadcast audience.
 *  Atomic (single DELETE … RETURNING) so two concurrent releases don't double-notify. */
export async function readAndClearResourceWaiters(
  tx: Sql,
  coordinationDomain: string,
  resource: string,
): Promise<string[]> {
  const rows = await tx<Array<{ owner: string }>>`
    DELETE FROM agent_resource_waiters
     WHERE coordination_domain = ${coordinationDomain}
       AND resource = ${resource}
       AND expires_ts > clock_timestamp()
    RETURNING owner
  `;
  return [...new Set(rows.map((r) => r.owner))];
}

/**
 * Reactive nudge for the exclusive wait loop: sweep this workspace's
 * expired resource holders, then run the drain cascade unconditionally.
 * Mirrors pokeWorkspace for the file locks — a shared holder whose TTL
 * lapsed without an explicit release fires no cascade on its own, so a
 * waiting exclusive would sit idle until the background janitor. The poke
 * sweeps the dead holder + completes the drain so the waiter wakes.
 */
export async function pokeResource(tx: Sql, coordinationDomain: string): Promise<void> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  await sweepResourceExpired(tx, coordinationDomain);
  await promoteResourceExclusiveQueue(tx, coordinationDomain);
}

/**
 * Acquire a named resource in `shared` or `exclusive` mode. Inside the
 * caller's inWorkspaceTxn.
 *
 *  - shared: granted unless another owner holds/pends an exclusive
 *    (writer-priority → exclusive_pending).
 *  - exclusive: rejected if the caller holds a shared lease (no upgrade,
 *    D-004 → holds_shared) or another owner holds exclusive
 *    (held_exclusive); else inserted as 'held' when no shared holders
 *    remain, or 'draining' while they finish.
 */
export async function tryAcquireResource(
  tx: Sql,
  params: ResourceAcquireParams,
): Promise<ResourceAcquireResult> {
  const {
    coordinationDomain: cd,
    resource,
    mode,
    owner,
    ownerLabel,
    reason,
    ttlSec,
    queueOnConflict = false,
  } = params;
  await tx`SET LOCAL statement_timeout = '500ms'`;

  // D-010: registered names only. Also fetch the D-008 semaphore capacity.
  const reg = await tx<Array<{ max_holders: number | null }>>`
    SELECT max_holders FROM agent_resource_registry WHERE resource = ${resource} LIMIT 1
  `;
  if (reg.length === 0) {
    return { ok: false, reason: 'unknown_resource', holders: [] };
  }

  // Clean expired holders first so conflict + drain checks see live state.
  await sweepResourceExpired(tx, cd);
  // Queue rows may have been left by a prior refused acquire, and a release
  // may have happened before this retry reached the transaction. Re-run the
  // idempotent cascade so the current FIFO head is visible before gating.
  await promoteResourceExclusiveQueue(tx, cd);

  const holders = await readLiveHolders(tx, cd, resource);
  const queue = await readLiveExclusiveQueue(tx, cd, resource);
  const ttlText = `${ttlSec} seconds`;

  if (mode === 'shared') {
    // The shared-admission rules live in ONE place: resource_acquire_shared
    // (sql/030). It applies writer priority with incumbent renewal
    // (EI-23229103052811419: a holder must be able to renew while an exclusive
    // drains, or the refresh itself drops it from the drain protocol), the D-008
    // capacity gate (a refresh never consumes a fresh slot), waiter recording,
    // and refuses to downgrade a held exclusive. The one-round-trip
    // acquireSharedResourceAtomic (resource-atomic.ts) calls the same function.
    // Here the caller's inWorkspaceTxn already holds the exclusive domain key,
    // so the function takes no locks of its own (feature key unused => NULL).
    // `holders` was read above, so the result shape is unchanged.
    const [row] = await tx<Array<{ result: SharedAcquireRpcResult }>>`
      SELECT resource_acquire_shared(
        NULL::integer, ${cd}, ${resource}, ${owner}, ${ownerLabel}, ${reason},
        ${ttlSec}::integer, ${WAITER_TTL_SEC}::integer, false, NULL::integer
      ) AS result
    `;
    const result = row.result;
    if (!result.ok) return { ok: false, reason: result.reason, holders };
    return {
      ok: true,
      mode: 'shared',
      status: 'held',
      lock_id: result.lock_id,
      expires_ts: new Date(result.expires_ts),
      shared_holders: holders.filter((h) => h.mode === 'shared'),
      fence_seq: 0, // fencing is exclusive-only (correctness-class); shared is efficiency-class.
    };
  }

  // mode === 'exclusive'
  // D-004: no in-place upgrade. A caller holding shared must release first.
  if (holders.some((h) => h.owner === owner && h.mode === 'shared')) {
    return { ok: false, reason: 'holds_shared', holders };
  }
  const callerOwnsExclusive = holders.some((h) => h.owner === owner && h.mode === 'exclusive');
  // Another owner's exclusive (held or draining) blocks.
  if (holders.some((h) => h.mode === 'exclusive' && h.owner !== owner)) {
    if (!queueOnConflict) {
      await clearResourceExclusiveQueue(tx, cd, resource, owner);
      await clearResourceWaiter(tx, cd, resource, owner);
      return { ok: false, reason: 'held_exclusive', holders };
    }
    const queued = await enqueueResourceExclusive(tx, {
      coordinationDomain: cd,
      resource,
      owner,
      ownerLabel,
      reason,
      ttlSec,
    });
    const queuedNow = await readLiveExclusiveQueue(tx, cd, resource);
    await recordResourceWaiter(tx, { coordinationDomain: cd, resource, owner, ownerLabel });
    return {
      ok: false,
      reason: 'held_exclusive',
      holders,
      queue_ticket: queued.ticket_id,
      queue_position: queuePosition(queuedNow, queued.ticket_id),
    };
  }

  // A request already ahead of this caller owns the FIFO head even when the
  // live holder query is momentarily empty (for example while a prior grant is
  // being retried). Do not let a new exclusive jump that ticket.
  const head = queue[0];
  if (!callerOwnsExclusive && head && head.owner !== owner) {
    if (!queueOnConflict) {
      await clearResourceExclusiveQueue(tx, cd, resource, owner);
      await clearResourceWaiter(tx, cd, resource, owner);
      return { ok: false, reason: 'held_exclusive', holders };
    }
    const queued = await enqueueResourceExclusive(tx, {
      coordinationDomain: cd,
      resource,
      owner,
      ownerLabel,
      reason,
      ttlSec,
    });
    const queuedNow = await readLiveExclusiveQueue(tx, cd, resource);
    await recordResourceWaiter(tx, { coordinationDomain: cd, resource, owner, ownerLabel });
    return {
      ok: false,
      // Preserve the established conflict vocabulary for existing callers;
      // the ticket fields carry the new FIFO state without breaking consumers.
      reason: 'held_exclusive',
      holders,
      queue_ticket: queued.ticket_id,
      queue_position: queuePosition(queuedNow, queued.ticket_id),
    };
  }

  const sharedHolders = holders.filter((h) => h.mode === 'shared');
  const status: ResourceLockStatus = sharedHolders.length === 0 ? 'held' : 'draining';
  const rows = await tx<Array<{ lock_id: string; expires_ts: Date; status: ResourceLockStatus }>>`
    INSERT INTO agent_resource_locks
      (coordination_domain, resource, owner, owner_label, mode, status, reason, expires_ts)
    VALUES
      (${cd}, ${resource}, ${owner}, ${ownerLabel}, 'exclusive', ${status}, ${reason},
       clock_timestamp() + ${ttlText}::interval)
    ON CONFLICT (coordination_domain, resource, owner) DO UPDATE
      SET owner_label = EXCLUDED.owner_label,
          reason      = EXCLUDED.reason,
          mode        = 'exclusive',
          status      = ${status},
          acquired_ts = clock_timestamp(),
          expires_ts  = EXCLUDED.expires_ts
    RETURNING lock_id::text AS lock_id, expires_ts, status
    `;
  if (rows.length === 0) {
    // A stale exclusive row or a concurrent queue promotion won the unique
    // constraint between the read and insert. Preserve the existing structured
    // conflict result rather than dereferencing an absent RETURNING row.
    const current = await readLiveHolders(tx, cd, resource);
    if (!queueOnConflict) {
      await clearResourceExclusiveQueue(tx, cd, resource, owner);
      await clearResourceWaiter(tx, cd, resource, owner);
      return { ok: false, reason: 'held_exclusive', holders: current };
    }
    const queued = await enqueueResourceExclusive(tx, {
      coordinationDomain: cd,
      resource,
      owner,
      ownerLabel,
      reason,
      ttlSec,
    });
    const queuedNow = await readLiveExclusiveQueue(tx, cd, resource);
    await recordResourceWaiter(tx, { coordinationDomain: cd, resource, owner, ownerLabel });
    return {
      ok: false,
      reason: 'held_exclusive',
      holders: current,
      queue_ticket: queued.ticket_id,
      queue_position: queuePosition(queuedNow, queued.ticket_id),
    };
  }
  // D-001: an exclusive that is effective NOW ('held', no shared holders to
  // drain) mints its fence here — the monotonic token the destructive action
  // re-checks before running. A 'draining' exclusive gets its fence later, from
  // resource_grant_cascade on the flip to 'held'.
  let fenceSeq = 0;
  if (rows[0].status === 'held') {
    const fr = await tx<Array<{ fence_seq: number }>>`
      UPDATE agent_resource_locks
         SET fence_seq = resource_assign_fence(${cd}, ${resource})
       WHERE coordination_domain = ${cd} AND resource = ${resource}
         AND owner = ${owner} AND mode = 'exclusive'
      RETURNING fence_seq::int AS fence_seq
    `;
    fenceSeq = fr[0]?.fence_seq ?? 0;
  }
  // Granted (or accepted as draining) — we're no longer waiting on this resource.
  await clearResourceExclusiveQueue(tx, cd, resource, owner);
  await clearResourceWaiter(tx, cd, resource, owner);
  return {
    ok: true,
    mode: 'exclusive',
    status: rows[0].status,
    lock_id: rows[0].lock_id,
    expires_ts: rows[0].expires_ts,
    shared_holders: sharedHolders,
    fence_seq: fenceSeq,
  };
}

export interface ResourceReleaseParams {
  coordinationDomain: string;
  owner: string;
  lockId?: string;
  resource?: string;
}

export interface ExpiredResourceLock {
  lockId: string;
  resource: string;
  mode: ResourceMode;
  expiredAt: Date;
}

/**
 * Release the caller's hold(s). After deleting, run the drain cascade —
 * releasing the last shared holder is exactly what completes a pending
 * exclusive's drain. Returns the modes released so the tool layer can
 * decide whether to broadcast "resource back up" (on an exclusive release).
 */
export async function tryReleaseResource(
  tx: Sql,
  params: ResourceReleaseParams,
): Promise<{
  released: number;
  releasedModes: ResourceMode[];
  exclusiveResources: string[];
  /** Holds matching this release that expired before the call could release
   * them. Captured before the expiry sweep removes the rows. */
  expired: ExpiredResourceLock[];
  /** owner ids who were waiting on each freed exclusive resource — the
   *  targeted back-up broadcast audience (A4). Cleared as part of this read. */
  waiters: Record<string, string[]>;
}> {
  const { coordinationDomain: cd, owner, lockId, resource } = params;
  await tx`SET LOCAL statement_timeout = '5s'`;

  // Capture matching expired rows before sweeping them. Once the sweep runs,
  // the database no longer retains enough information for the caller to tell
  // "expired before release" from "nothing matched this selector".
  let expiredRows: Array<{
    lock_id: string;
    resource: string;
    mode: ResourceMode;
    expires_ts: Date;
  }>;
  if (lockId) {
    expiredRows = await tx`
      SELECT lock_id::text AS lock_id, resource, mode, expires_ts
        FROM agent_resource_locks
       WHERE coordination_domain = ${cd}
         AND lock_id = ${lockId}::uuid
         AND owner = ${owner}
         AND expires_ts <= clock_timestamp()
    `;
  } else if (resource) {
    expiredRows = await tx`
      SELECT lock_id::text AS lock_id, resource, mode, expires_ts
        FROM agent_resource_locks
       WHERE coordination_domain = ${cd}
         AND resource = ${resource}
         AND owner = ${owner}
         AND expires_ts <= clock_timestamp()
    `;
  } else {
    throw new Error('tryReleaseResource requires lockId or resource');
  }

  await sweepResourceExpired(tx, cd);

  let deleted: Array<{ mode: ResourceMode; resource: string }>;
  if (lockId) {
    deleted = await tx<Array<{ mode: ResourceMode; resource: string }>>`
      DELETE FROM agent_resource_locks
       WHERE coordination_domain = ${cd} AND lock_id = ${lockId}::uuid AND owner = ${owner}
      RETURNING mode, resource
    `;
  } else if (resource) {
    deleted = await tx<Array<{ mode: ResourceMode; resource: string }>>`
      DELETE FROM agent_resource_locks
       WHERE coordination_domain = ${cd} AND resource = ${resource} AND owner = ${owner}
      RETURNING mode, resource
    `;
  } else {
    throw new Error('tryReleaseResource requires lockId or resource');
  }

  await promoteResourceExclusiveQueue(tx, cd);
  // Resources whose EXCLUSIVE hold was just released — the back-up broadcast
  // audience (P-010). Distinct; empty when only shared rows were released.
  const exclusiveResources = [
    ...new Set(deleted.filter((d) => d.mode === 'exclusive').map((d) => d.resource)),
  ];
  // Read + clear the waiters on each freed exclusive — they're the targeted
  // back-up audience (A4), replacing the old ['*'] broadcast.
  const waiters: Record<string, string[]> = {};
  for (const res of exclusiveResources) {
    waiters[res] = await readAndClearResourceWaiters(tx, cd, res);
  }
  const expired = expiredRows.map((row) => ({
    lockId: row.lock_id,
    resource: row.resource,
    mode: row.mode,
    expiredAt: row.expires_ts,
  }));
  return { released: deleted.length, releasedModes: deleted.map((d) => d.mode), exclusiveResources, expired, waiters };
}

/**
 * Release EVERY named-resource lock this owner holds in the workspace —
 * the session-end cleanup (P-019). Mirrors tryRelease's all_mine for file
 * locks; the locks:release tool calls both on `all_mine: true` so one
 * session-end call frees files AND resources (TTL is the backstop for a
 * crashed session). Returns the exclusiveResources for the back-up broadcast.
 */
export async function releaseAllResourcesForOwner(
  tx: Sql,
  coordinationDomain: string,
  owner: string,
): Promise<{ released: number; exclusiveResources: string[]; waiters: Record<string, string[]> }> {
  await tx`SET LOCAL statement_timeout = '5s'`;
  const deleted = await tx<Array<{ mode: ResourceMode; resource: string }>>`
    DELETE FROM agent_resource_locks
     WHERE coordination_domain = ${coordinationDomain} AND owner = ${owner}
    RETURNING mode, resource
  `;
  // The departing owner is no longer waiting on anything either.
  await tx`DELETE FROM agent_resource_waiters WHERE coordination_domain = ${coordinationDomain} AND owner = ${owner}`;
  await tx`DELETE FROM agent_resource_exclusive_queue WHERE coordination_domain = ${coordinationDomain} AND owner = ${owner}`;
  await promoteResourceExclusiveQueue(tx, coordinationDomain);
  const exclusiveResources = [
    ...new Set(deleted.filter((d) => d.mode === 'exclusive').map((d) => d.resource)),
  ];
  const waiters: Record<string, string[]> = {};
  for (const res of exclusiveResources) {
    waiters[res] = await readAndClearResourceWaiters(tx, coordinationDomain, res);
  }
  return { released: deleted.length, exclusiveResources, waiters };
}

/**
 * Extend a held resource lease's TTL. Owner-checked like tryHeartbeat.
 */
export async function tryHeartbeatResource(
  tx: Sql,
  coordinationDomain: string,
  owner: string,
  lockId: string,
  ttlSec: number,
): Promise<{ expires_ts: Date | null; extended: boolean }> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  await sweepResourceExpired(tx, coordinationDomain);
  await promoteResourceExclusiveQueue(tx, coordinationDomain);

  const ttlText = `${ttlSec} seconds`;
  const rows = await tx<Array<{ expires_ts: Date }>>`
    UPDATE agent_resource_locks
       SET expires_ts = clock_timestamp() + ${ttlText}::interval
     WHERE coordination_domain = ${coordinationDomain}
       AND lock_id = ${lockId}::uuid
       AND owner = ${owner}
       AND expires_ts > clock_timestamp()
    RETURNING expires_ts
  `;
  if (rows.length === 0) return { expires_ts: null, extended: false };
  return { expires_ts: rows[0].expires_ts, extended: true };
}

/**
 * WI-10004326: the coordination domain a named-resource lease ACTUALLY lives in,
 * located by its globally unique `lock_id` + owner.
 *
 * A lock_id-only heartbeat or release cannot know the resource name, so it used
 * to try only the domains the SERVING operator can infer. For a caller-tree
 * resource that inference is the serving operator's own checkout, which differs
 * per install: a lease acquired through the staging operator lives in the
 * staging checkout's domain, and the same lock_id heartbeated through the green
 * operator (release checkout) found nothing (measured 2026-09-30: not_found via
 * one port, extended:true via the other, same lock_id). Reading the row's own
 * domain removes the inference instead of adding another guess to it.
 *
 * Owner-scoped, so it only ever locates the caller's OWN lease and widens no
 * authority. Expired rows are included on purpose: release reports expiry
 * evidence from the lease's domain. `null` = this owner holds no row with that id.
 * Served by idx_reslocks_owner (an owner holds a handful of leases).
 */
export async function readOwnedResourceLockDomain(
  sql: Sql,
  lockId: string,
  owner: string,
): Promise<string | null> {
  const rows = await sql<Array<{ coordination_domain: string }>>`
    SELECT coordination_domain
      FROM agent_resource_locks
     WHERE owner = ${owner}
       AND lock_id = ${lockId}::uuid
     LIMIT 1
  `;
  return rows[0]?.coordination_domain ?? null;
}

export interface ResourceLockStatusResult {
  status: ResourceLockStatus | 'missing';
  mode?: ResourceMode;
  resource?: string;
  expires_ts?: Date;
  /** Fencing token of this lock (D-001) — non-zero once an exclusive is 'held'. */
  fence_seq?: number;
}

/**
 * Read one lock's current state by id — the exclusive waiter loop polls
 * this to detect draining → held. 'missing' = released or expired.
 */
export async function readResourceLockStatus(
  sql: Sql,
  lockId: string,
): Promise<ResourceLockStatusResult> {
  const rows = await sql<
    Array<{
      status: ResourceLockStatus;
      mode: ResourceMode;
      resource: string;
      expires_ts: Date;
      fence_seq: number;
    }>
  >`
    SELECT status, mode, resource, expires_ts, fence_seq::int AS fence_seq
      FROM agent_resource_locks
     WHERE lock_id = ${lockId}::uuid
       AND expires_ts > clock_timestamp()
     LIMIT 1
  `;
  if (rows.length === 0) return { status: 'missing' };
  return {
    status: rows[0].status,
    mode: rows[0].mode,
    resource: rows[0].resource,
    expires_ts: rows[0].expires_ts,
    fence_seq: rows[0].fence_seq,
  };
}

export interface ResourceQueueResult {
  holders: ResourceHolder[];
  /** True when any live exclusive on the queried set is still draining. */
  draining: boolean;
  /** Live pending exclusive requests in FIFO order (per resource). */
  queue?: ResourceExclusiveQueueEntry[];
}

/**
 * List the live holders for a workspace (optionally one resource), plus a
 * draining flag — the data behind locks:queue for named resources.
 */
export async function readResourceQueue(
  sql: Sql,
  params: { coordinationDomain: string; resource?: string },
): Promise<ResourceQueueResult> {
  const { coordinationDomain: cd, resource } = params;
  const holders = resource
    ? await sql<ResourceHolder[]>`
        SELECT resource, owner, owner_label, mode, status, lock_id::text AS lock_id, reason,
               acquired_ts, expires_ts, fence_seq::int AS fence_seq
          FROM agent_resource_locks
         WHERE coordination_domain = ${cd}
           AND resource = ${resource}
           AND expires_ts > clock_timestamp()
         ORDER BY acquired_ts ASC
      `
    : await sql<ResourceHolder[]>`
        SELECT resource, owner, owner_label, mode, status, lock_id::text AS lock_id, reason,
               acquired_ts, expires_ts, fence_seq::int AS fence_seq
          FROM agent_resource_locks
         WHERE coordination_domain = ${cd}
           AND expires_ts > clock_timestamp()
         ORDER BY acquired_ts ASC
      `;
  const queue = await readLiveExclusiveQueue(sql, cd, resource);
  const draining = holders.some((h) => h.mode === 'exclusive' && h.status === 'draining');
  return { holders, draining, queue };
}

/**
 * Every coordination domain that holds a LIVE lease on `resource`, keyed on the
 * NAME alone (EI-24434173247501787).
 *
 * A caller-tree domain is the repo root of the SERVING operator's checkout, so
 * two operators serving from different checkouts (:3070 = papercup-release,
 * :3170 = papercusp-staging) put the same undeclared resource in two different
 * domains. A domain-scoped read cannot see the other one — that is how an
 * exclusive `p013-benchmark-rig` hold in one domain let a second exclusive
 * acquire succeed in the other. Readers that must not under-report a holder
 * union this set into the domains they scan.
 *
 * Omit `resource` to list every domain holding ANY live lease — the unscoped
 * `locks:list` read has the same blind spot.
 *
 * Read-only. `agent_resource_locks` holds only live-or-recently-expired leases,
 * so the scan stays small without a dedicated index.
 */
export async function listLiveResourceDomains(sql: Sql, resource?: string): Promise<string[]> {
  const rows = resource
    ? await sql<Array<{ coordination_domain: string }>>`
        SELECT DISTINCT coordination_domain
          FROM agent_resource_locks
         WHERE resource = ${resource}
           AND expires_ts > clock_timestamp()
      `
    : await sql<Array<{ coordination_domain: string }>>`
        SELECT DISTINCT coordination_domain
          FROM agent_resource_locks
         WHERE expires_ts > clock_timestamp()
      `;
  return rows.map((r) => r.coordination_domain);
}

// ───────── Fencing (D-001) ─────────

export type FenceCheck =
  | { current: true; live_fence_seq: number }
  | {
      current: false;
      /** 'expired_or_released' — no live exclusive holds this resource at all;
       *  'superseded' — a DIFFERENT exclusive grant now holds it (our TTL lapsed
       *  and it was re-granted — the classic paused/zombie holder). */
      reason: 'expired_or_released' | 'superseded';
      live_fence_seq?: number;
    };

/**
 * Re-verify, against PG, that the caller still holds the EFFECTIVE exclusive on
 * `resource` at fence `fenceSeq` (D-001). The destructive action calls this
 * immediately before it mutates: a stale fence (TTL lapsed, re-granted to
 * another owner) is rejected, so a paused/zombie holder cannot corrupt shared
 * state. There is at most one live exclusive per (domain, resource) — the
 * partial unique index — so "still mine" reduces to: the live held exclusive's
 * lock_id is ours. The monotonic fence is the ordering token a downstream
 * service / the action ledger keys on; we also assert it hasn't gone backwards.
 *
 * Read-only (a point lookup) — takes the pool, no advisory lock needed.
 */
export async function assertResourceFenceCurrent(
  sql: Sql,
  params: { coordinationDomain: string; resource: string; lockId: string; fenceSeq: number },
): Promise<FenceCheck> {
  const { coordinationDomain: cd, resource, lockId, fenceSeq } = params;
  const rows = await sql<Array<{ lock_id: string; fence_seq: number }>>`
    SELECT lock_id::text AS lock_id, fence_seq::int AS fence_seq
      FROM agent_resource_locks
     WHERE coordination_domain = ${cd}
       AND resource = ${resource}
       AND mode = 'exclusive'
       AND status = 'held'
       AND expires_ts > clock_timestamp()
     LIMIT 1
  `;
  if (rows.length === 0) return { current: false, reason: 'expired_or_released' };
  const live = rows[0];
  // A different grant now holds the exclusive, or the fence advanced past ours
  // under a different lock_id — either way we were superseded.
  if (live.lock_id !== lockId || live.fence_seq < fenceSeq) {
    return { current: false, reason: 'superseded', live_fence_seq: live.fence_seq };
  }
  return { current: true, live_fence_seq: live.fence_seq };
}

export interface ResourceActionRecord {
  applied: boolean;
  fence_seq?: number;
  applied_ts?: Date;
}

/**
 * Resource-side idempotency check (D-001): has `actionKey` already been applied
 * in this domain? The explicit generalization of the su_meta migration-name
 * check — a retried / zombie re-apply of the same action is a checked no-op.
 * Read-only; takes the pool.
 */
export async function checkResourceAction(
  sql: Sql,
  coordinationDomain: string,
  actionKey: string,
): Promise<ResourceActionRecord> {
  const rows = await sql<Array<{ fence_seq: number; applied_ts: Date }>>`
    SELECT fence_seq::int AS fence_seq, applied_ts
      FROM agent_resource_action_log
     WHERE coordination_domain = ${coordinationDomain} AND action_key = ${actionKey}
     LIMIT 1
  `;
  if (rows.length === 0) return { applied: false };
  return { applied: true, fence_seq: rows[0].fence_seq, applied_ts: rows[0].applied_ts };
}

/**
 * Record that `actionKey` was applied at fence `fenceSeq`. Inside the caller's
 * txn. First writer wins (ON CONFLICT DO NOTHING) — a racing second apply finds
 * the row already present and treats itself as the checked no-op. Returns true
 * if THIS call recorded it (i.e. the action should run), false if already done.
 */
export async function recordResourceAction(
  tx: Sql,
  coordinationDomain: string,
  actionKey: string,
  fenceSeq: number,
): Promise<boolean> {
  const rows = await tx<Array<{ action_key: string }>>`
    INSERT INTO agent_resource_action_log (coordination_domain, action_key, fence_seq)
    VALUES (${coordinationDomain}, ${actionKey}, ${fenceSeq})
    ON CONFLICT (coordination_domain, action_key) DO NOTHING
    RETURNING action_key
  `;
  return rows.length > 0;
}

// ───────── Registry (D-010) ─────────

function mapRegistry(r: {
  resource: string;
  description: string;
  rule_text: string;
  enforcement: ResourceEnforcement;
  match_patterns: string[] | null;
  max_holders: number | null;
}): ResourceRegistryRow {
  return {
    resource: r.resource,
    description: r.description,
    rule_text: r.rule_text,
    enforcement: r.enforcement,
    match_patterns: r.match_patterns ?? [],
    max_holders: r.max_holders ?? null,
  };
}

export async function listResources(sql: Sql): Promise<ResourceRegistryRow[]> {
  const rows = await sql<
    Array<{
      resource: string;
      description: string;
      rule_text: string;
      enforcement: ResourceEnforcement;
      match_patterns: string[] | null;
      max_holders: number | null;
    }>
  >`
    SELECT resource, description, rule_text, enforcement, match_patterns, max_holders
      FROM agent_resource_registry
     ORDER BY resource ASC
  `;
  return rows.map(mapRegistry);
}

export async function getResource(
  sql: Sql,
  resource: string,
): Promise<ResourceRegistryRow | null> {
  const rows = await sql<
    Array<{
      resource: string;
      description: string;
      rule_text: string;
      enforcement: ResourceEnforcement;
      match_patterns: string[] | null;
      max_holders: number | null;
    }>
  >`
    SELECT resource, description, rule_text, enforcement, match_patterns, max_holders
      FROM agent_resource_registry
     WHERE resource = ${resource}
     LIMIT 1
  `;
  return rows[0] ? mapRegistry(rows[0]) : null;
}

export interface UpsertResourceInput {
  resource: string;
  description?: string;
  rule_text?: string;
  enforcement?: ResourceEnforcement;
  match_patterns?: string[];
  /** Counting-semaphore capacity (D-008). null/undefined = unbounded shared. */
  max_holders?: number | null;
}

export async function upsertResource(
  tx: Sql,
  row: UpsertResourceInput,
): Promise<ResourceRegistryRow> {
  const rows = await tx<
    Array<{
      resource: string;
      description: string;
      rule_text: string;
      enforcement: ResourceEnforcement;
      match_patterns: string[] | null;
      max_holders: number | null;
    }>
  >`
    INSERT INTO agent_resource_registry
      (resource, description, rule_text, enforcement, match_patterns, max_holders, updated_ts)
    VALUES
      (${row.resource}, ${row.description ?? ''}, ${row.rule_text ?? ''},
       ${row.enforcement ?? 'advisory'}, ${row.match_patterns ?? []}, ${row.max_holders ?? null}, clock_timestamp())
    ON CONFLICT (resource) DO UPDATE
      SET description    = EXCLUDED.description,
          rule_text      = EXCLUDED.rule_text,
          enforcement    = EXCLUDED.enforcement,
          match_patterns = EXCLUDED.match_patterns,
          max_holders    = EXCLUDED.max_holders,
          updated_ts     = clock_timestamp()
    RETURNING resource, description, rule_text, enforcement, match_patterns, max_holders
  `;
  return mapRegistry(rows[0]);
}

export interface RegisterResourceResult {
  created: boolean;
  resource: ResourceRegistryRow;
}

/** Register a named resource without rewriting an existing coordination policy. */
export async function registerResource(
  tx: Sql,
  row: UpsertResourceInput,
): Promise<RegisterResourceResult> {
  const rows = await tx<
    Array<{
      resource: string;
      description: string;
      rule_text: string;
      enforcement: ResourceEnforcement;
      match_patterns: string[] | null;
      max_holders: number | null;
    }>
  >`
    INSERT INTO agent_resource_registry
      (resource, description, rule_text, enforcement, match_patterns, max_holders, updated_ts)
    VALUES
      (${row.resource}, ${row.description ?? ''}, ${row.rule_text ?? ''},
       ${row.enforcement ?? 'advisory'}, ${row.match_patterns ?? []}, ${row.max_holders ?? null}, clock_timestamp())
    ON CONFLICT (resource) DO NOTHING
    RETURNING resource, description, rule_text, enforcement, match_patterns, max_holders
  `;
  if (rows[0]) return { created: true, resource: mapRegistry(rows[0]) };

  const existing = await getResource(tx, row.resource);
  if (!existing) throw new Error(`resource registration race lost without a row: ${row.resource}`);
  return { created: false, resource: existing };
}

/**
 * WI-562584: which coordination domain a named resource's holders live in —
 * declared ON the registry row (sql/027) instead of inferred from the resource
 * NAME by every reader independently.
 *
 * `tree` is the default and means UNDECLARED: readers fall through to their own
 * name inference for it, so this value can promote a resource out of the
 * caller-tree domain but never demote one into it.
 */
export type ResourceCoordinationDomainKind = 'tree' | 'workspace' | 'host-global';

/**
 * Every resource whose declared domain kind is NOT the `tree` default.
 *
 * Deliberately returns only the non-default rows: the caller's fallback for an
 * absent entry is identical to its fallback for an explicit `tree`, so shipping
 * the (large, all-default) remainder would buy nothing and grow with the
 * registry. Read through the plain pool — no advisory lock: this is a cache
 * refresh, not part of any acquire's transaction.
 */
export async function readResourceCoordinationDomainKinds(
  sql: Sql,
): Promise<Map<string, ResourceCoordinationDomainKind>> {
  const rows = await sql<Array<{ resource: string; coordination_domain_kind: string }>>`
    SELECT resource, coordination_domain_kind
      FROM agent_resource_registry
     WHERE coordination_domain_kind <> 'tree'
  `;
  const kinds = new Map<string, ResourceCoordinationDomainKind>();
  for (const r of rows) {
    if (r.coordination_domain_kind === 'workspace' || r.coordination_domain_kind === 'host-global') {
      kinds.set(r.resource, r.coordination_domain_kind);
    }
  }
  return kinds;
}

/**
 * Stamp the domain kind an ACQUIRER resolves for `resource` onto its existing
 * registry row, so every other reader resolves the same one.
 *
 * An UPDATE, never an upsert: the rows that need this most are the human-created
 * `extra_lock_resources` names (git-sync auto-registers ONLY its own
 * `git-sync:<slug>`), and inserting a placeholder row for an unregistered name
 * would turn today's loud `unknown_resource` refusal into a silent grant.
 * Returns whether a row was updated — `false` means the name is not registered.
 */
export async function stampResourceCoordinationDomainKind(
  tx: Sql,
  resource: string,
  kind: ResourceCoordinationDomainKind,
): Promise<boolean> {
  const rows = await tx<Array<{ resource: string }>>`
    UPDATE agent_resource_registry
       SET coordination_domain_kind = ${kind}, updated_ts = clock_timestamp()
     WHERE resource = ${resource}
       AND coordination_domain_kind IS DISTINCT FROM ${kind}
    RETURNING resource
  `;
  if (rows.length > 0) return true;
  const existing = await tx<Array<{ resource: string }>>`
    SELECT resource FROM agent_resource_registry WHERE resource = ${resource} LIMIT 1
  `;
  return existing.length > 0;
}
