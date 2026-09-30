/**
 * Which coordination domains does an owner ACTUALLY hold file locks in?
 *
 * Extracted from `release.ts` (EI-20405390083792304) so `heartbeat.ts` can
 * reuse the same resolution instead of growing a second copy
 * (EI-20413003247462580). Both tools face the identical problem: they are
 * handed a `lock_id` alone, and a lock_id carries no domain, so a caller
 * whose own domain differs from the lock's silently addresses the wrong rows.
 *
 * WHY NOT A CANDIDATE LIST. The resource-lock side solves the identical
 * "selected by id alone, domain unknown at this call site" problem with
 * `candidateResourceLockDomains()` — a FIXED list (caller / host-global /
 * workspace). That shape cannot work for FILE locks: a file lock's domain is
 * the physical repo root of the edited file, and the PreToolUse hook sends it
 * EXPLICITLY, so the domain set is unbounded and discovered at runtime (one
 * per hive tree under ~/.papercusp/hives/*, per worktree, per checkout).
 * Enumerating candidates would silently miss whichever tree nobody thought of
 * — the same class of miss as the bug itself. A lock_id is a UUID and `owner`
 * is globally unique (WI-5979), so the rows can just be ASKED.
 *
 * Reuses `readQueue`'s null-domain diagnostic read — the exact path proven
 * live to see hive-domain rows — instead of adding parallel SQL.
 */

import { acquireWithContentionRetry } from './contention-retry';
import { readQueue, getTxPool, ensureBootstrap } from './su-lock-store';

export type DomainsHoldingLocksOpts = {
  /** The lock owner to resolve for — globally unique (WI-5979). */
  ownerId: string;
  /**
   * Narrow to the domain holding THIS lock. Omitted ⇒ every domain the owner
   * holds anything in (the `all_mine` shape).
   */
  lockId?: string;
  /**
   * A domain to leave out of the result — normally the caller's own, which it
   * has already operated on directly.
   */
  exclude?: string;
};

/**
 * The domains this owner holds live locks in, resolved FROM THE LOCK ROWS
 * rather than guessed. Returns `[]` when there is nothing else to reach —
 * which is a real answer ("no cross-domain holdings"), not a failure.
 */
export async function domainsHoldingLocks({
  ownerId,
  lockId,
  exclude,
}: DomainsHoldingLocksOpts): Promise<string[]> {
  await ensureBootstrap();
  const snapshot = await acquireWithContentionRetry(() =>
    readQueue(getTxPool(), { coordinationDomain: null, owner: ownerId }),
  );
  const domains = new Set<string>();
  for (const row of snapshot.active_locks) {
    if (exclude !== undefined && row.coordination_domain === exclude) continue;
    // A selected op only reaches into the domain holding THAT lock; an
    // all-mine op reaches into every domain this owner holds anything in.
    if (lockId && row.lock_id !== lockId) continue;
    domains.add(row.coordination_domain);
  }
  return [...domains];
}

export type OwnedLockPaths = {
  /** The release handle shared by every selected row in this group. */
  lockId: string;
  /** Only the requested paths held by this owner under this lock id. */
  paths: string[];
};

/**
 * Resolve path-only release requests to the caller's active lock sets.
 *
 * The read is deliberately cross-domain: the operator handling a release can
 * run from a different checkout than the edit hook that acquired the lock.
 * `owner` is the access boundary, and the returned rows are grouped by
 * lock_id so the caller can reuse the normal owner-checked release path without
 * widening a partial release into a whole lock-set release.
 */
export async function ownedLocksForPaths({
  ownerId,
  paths,
}: {
  ownerId: string;
  paths: readonly string[];
}): Promise<OwnedLockPaths[]> {
  const requestedPaths = [...new Set(paths)];
  if (requestedPaths.length === 0) return [];

  await ensureBootstrap();
  const snapshot = await acquireWithContentionRetry(() =>
    readQueue(getTxPool(), {
      coordinationDomain: null,
      owner: ownerId,
      paths: requestedPaths,
    }),
  );
  const requested = new Set(requestedPaths);
  const grouped = new Map<string, OwnedLockPaths>();
  for (const row of snapshot.active_locks) {
    // `owner` and `paths` are also enforced by readQueue's SQL. Keep the
    // checks here because test seams and older authorities may return a wider
    // diagnostic snapshot than the requested filter.
    if (row.owner !== ownerId || !requested.has(row.path)) continue;
    const existing = grouped.get(row.lock_id);
    if (existing) {
      if (!existing.paths.includes(row.path)) existing.paths.push(row.path);
      continue;
    }
    grouped.set(row.lock_id, { lockId: row.lock_id, paths: [row.path] });
  }
  return [...grouped.values()];
}
