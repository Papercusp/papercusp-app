/**
 * fleet/lock-release — the production "release a cancelled agent's locks NOW" effect.
 *
 * This is the papercusp binding of the toolkit's `LockReleaser` port. Transitive
 * cancellation's whole point over the lease-timeout model is that a cancelled
 * descendant's locks are freed IMMEDIATELY. File locks + named resource locks live in
 * papercusp_su keyed by (coordination_domain, owner), in a SEPARATE database from the
 * spawn tree — so this is a cross-DB effect, deliberately kept out of the nursery's
 * harness_shared transaction (locks are efficiency-class / fail-open: a partial failure
 * here just falls back to the lease).
 *
 * Mirrors locks:release's all_mine path: file locks via tryRelease({allMine}) + named
 * resources via releaseAllResourcesForOwner, each in its own per-workspace advisory txn.
 */
import { inWorkspaceTxn } from '../agent-tools/locks/in-workspace-txn';
import { tryRelease, releaseAllResourcesForOwner } from '../agent-tools/locks/su-lock-store';

// The lock-effect vocabulary now lives in the toolkit; re-export for in-app call sites.
export type { LockTarget, LockReleaseResult, LockReleaser } from '@papercusp/structured-concurrency';
import type { LockReleaseResult, LockTarget } from '@papercusp/structured-concurrency';

/**
 * Release every file + resource lock held by each target owner. Used by transitive
 * cancellation. De-dupes targets on (domain, owner). Best-effort per owner: one owner's
 * failure (e.g. su DB unreachable) does not abort the rest — cancellation must make as
 * much progress as it can; the lease backstops anything missed.
 */
export async function releaseAllLocksForOwners(targets: LockTarget[]): Promise<LockReleaseResult> {
  const seen = new Set<string>();
  const owners: string[] = [];
  let filePathsReleased = 0;
  let resourcesReleased = 0;

  for (const { coordinationDomain, owner } of targets) {
    if (!owner) continue;
    const key = `${coordinationDomain} ${owner}`;
    if (seen.has(key)) continue;
    seen.add(key);
    owners.push(owner);

    try {
      const released = await inWorkspaceTxn(coordinationDomain, owner, (tx) =>
        tryRelease(tx, { coordinationDomain, owner, allMine: true }),
      );
      filePathsReleased += released.released.length;
    } catch {
      /* fail-open: the file lock's lease will expire on its own. */
    }
    try {
      const rr = await inWorkspaceTxn(coordinationDomain, owner, (tx) =>
        releaseAllResourcesForOwner(tx, coordinationDomain, owner),
      );
      resourcesReleased += rr.released;
    } catch {
      /* fail-open: the resource lease will drain on its own. */
    }
  }

  return { owners, filePathsReleased, resourcesReleased };
}
