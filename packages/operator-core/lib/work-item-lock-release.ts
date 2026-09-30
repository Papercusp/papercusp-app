/**
 * Targeted file-lock release for an announced work-item reclaim.
 *
 * A consequence reclaim must free the paths the item declared, but must not
 * release every lock held by the former owner: an owner can be working on a
 * second item at the same time. `readQueue` is the diagnostic authority that
 * can enumerate the owner's locks across coordination domains; the grouped
 * `lock_id` + `paths` release preserves unrelated paths in the same lock set.
 */
import { inWorkspaceTxn } from './agent-tools/locks/in-workspace-txn';
import { ensureBootstrap, getTxPool, readQueue, tryRelease } from './agent-tools/locks/su-lock-store';

export interface ReclaimWorkItemLocksParams {
  ownerId: string | null | undefined;
  paths: readonly string[] | null | undefined;
  /** The reclaimed work-item id; new lock rows are matched by this durable ref. */
  goalRef?: string | null | undefined;
}

export interface ReclaimWorkItemLockRelease {
  coordinationDomain: string;
  lockId: string;
  paths: string[];
  released: string[];
}

export interface ReclaimWorkItemLocksResult {
  releases: ReclaimWorkItemLockRelease[];
  /** A read/release failure is fail-open: claim release still proceeds. */
  failures: number;
  skipped: 'missing-owner' | 'no-paths' | null;
}

type ActiveLock = {
  coordination_domain: string;
  lock_id: string;
  owner: string;
  path: string;
  goal_ref: string | null;
};

/** Keep only concrete, non-blank paths and preserve their declaration order. */
export function normalizeReclaimPaths(paths: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths ?? []) {
    const normalized = typeof path === 'string' ? path.trim() : '';
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Release only the former holder's active locks that overlap the item's declared
 * touch-set. The lock store's `tryRelease` runs `grant_cascade`, so a successor
 * waiting on one of these paths can acquire immediately after this returns.
 */
export async function releaseReclaimedWorkItemLocks(
  params: ReclaimWorkItemLocksParams,
): Promise<ReclaimWorkItemLocksResult> {
  const ownerId = typeof params.ownerId === 'string' ? params.ownerId.trim() : '';
  if (!ownerId) return { releases: [], failures: 0, skipped: 'missing-owner' };

  const paths = normalizeReclaimPaths(params.paths);
  const goalRef = typeof params.goalRef === 'string' ? params.goalRef.trim() : '';
  if (paths.length === 0 && !goalRef) return { releases: [], failures: 0, skipped: 'no-paths' };
  const targetPaths = new Set(paths);

  let activeLocks: ActiveLock[];
  try {
    await ensureBootstrap();
    const queue = await readQueue(getTxPool(), { coordinationDomain: null, owner: ownerId });
    activeLocks = queue.active_locks as ActiveLock[];
  } catch (error) {
    console.warn(
      `[work-item-lock-reclaim] could not inspect locks for ${ownerId}; claim release will proceed and leases remain as fallback (${error instanceof Error ? error.message : String(error)})`,
    );
    return { releases: [], failures: 1, skipped: null };
  }

  // New rows are selected by owner + goal_ref, so a pathless work-item reclaim
  // cannot strand its locks or touch another concurrent item held by the same
  // owner. Legacy NULL rows retain the declared-path fallback only.
  // A single locks:acquire may own several paths under one lock_id. Grouping is
  // required so tryRelease can delete only the declared subset, not the whole
  // lock set; including the domain prevents cross-tree UUID collisions in the
  // diagnostic snapshot.
  const groups = new Map<string, { coordinationDomain: string; lockId: string; paths: string[] }>();
  for (const row of activeLocks) {
    if (row.owner !== ownerId) continue;
    const matchesGoal = Boolean(goalRef) && row.goal_ref === goalRef;
    const matchesLegacyPath = row.goal_ref == null && targetPaths.has(row.path);
    if (!matchesGoal && !matchesLegacyPath) continue;
    const key = `${row.coordination_domain}\0${row.lock_id}`;
    const group = groups.get(key) ?? {
      coordinationDomain: row.coordination_domain,
      lockId: row.lock_id,
      paths: [],
    };
    group.paths.push(row.path);
    groups.set(key, group);
  }

  const releases: ReclaimWorkItemLockRelease[] = [];
  let failures = 0;
  for (const group of groups.values()) {
    try {
      const result = await inWorkspaceTxn(group.coordinationDomain, ownerId, (tx) =>
        tryRelease(tx, {
          coordinationDomain: group.coordinationDomain,
          owner: ownerId,
          lockId: group.lockId,
          paths: group.paths,
        }),
        { paths: group.paths },
      );
      releases.push({
        coordinationDomain: group.coordinationDomain,
        lockId: group.lockId,
        paths: group.paths,
        released: result.released,
      });
    } catch (error) {
      failures += 1;
      console.warn(
        `[work-item-lock-reclaim] could not release ${group.coordinationDomain}:${group.lockId} for ${ownerId}; lease remains as fallback (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  return { releases, failures, skipped: null };
}
