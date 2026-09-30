/**
 * Release every file + named-resource lock held by one owner.
 *
 * This is the shared implementation behind `locks:release { all_mine:true }`
 * and the real-session-death lifecycle cleanup. Keeping both callers on this
 * seam is load-bearing: file locks are keyed by the physical repository root,
 * so one owner can hold locks in several coordination domains (for example the
 * canonical staging tree plus a Hive tree). A caller-domain-only delete leaves
 * the other rows alive until their lease expires.
 */
import type { AgentIdentity } from '../coordination/identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { acquireWithContentionRetry } from './contention-retry';
import {
  tryRelease,
  releaseAllResourcesForOwner,
  releaseAllGranularForOwner,
} from './su-lock-store';
import { notifyPlanLockChange } from './notify-lock-change';
import { broadcastResourceBackUp } from './resource-broadcast';
import { routeFileLockOp } from '../../authority/file-lock-routing';
import {
  FILE_LOCK_OP_KINDS,
  emitReleaseLockEvents,
  type FileLockReleaseParams,
} from '../../authority/file-lock-authority-ops';
import { recordLockEvent } from '../../authority/lock-event-stream';
import { noteShaTokenRelease } from '../../authority/sha-token-registry';
import { domainsHoldingLocks } from './owner-lock-domains';
import { candidateResourceLockDomains } from './coordination-domain';

type ReleaseOutcome = { released: string[]; heldBefore: number | null };

export interface ReleaseAllOwnedLocksResult {
  released: string[];
  heldBefore: number | null;
  crossDomainReleased: Array<{ coordination_domain: string; released: string[] }>;
  granularReleased: number;
  resourcesReleased: number;
}

export async function releaseAllOwnedLocks(params: {
  ownerId: string;
  primaryCoordinationDomain: string;
  source?: AgentIdentity;
}): Promise<ReleaseAllOwnedLocksResult> {
  const { ownerId, primaryCoordinationDomain, source } = params;

  // Resolve the complete domain set BEFORE deleting the primary rows. The
  // diagnostic read is the only existing authority that can enumerate an
  // unbounded set of physical repo roots; guessing candidate paths recreates
  // the original Hive-lock miss.
  let heldDomains: string[] = [];
  try {
    heldDomains = await domainsHoldingLocks({ ownerId });
  } catch {
    // Best-effort widening. The primary domain still gets its normal release,
    // and the lease remains the backstop if the diagnostic read is unavailable.
  }
  const fileDomains = [...new Set([primaryCoordinationDomain, ...heldDomains])];
  const released: string[] = [];
  const crossDomainReleased: Array<{ coordination_domain: string; released: string[] }> = [];
  let heldBefore: number | null = 0;
  let granularReleased = 0;

  for (const domain of fileDomains) {
    const localRelease = (): Promise<ReleaseOutcome> =>
      inWorkspaceTxn(domain, ownerId, (tx) =>
        tryRelease(tx, {
          coordinationDomain: domain,
          owner: ownerId,
          allMine: true,
        }),
      );

    let routed;
    try {
      routed = await acquireWithContentionRetry(() =>
        routeFileLockOp<ReleaseOutcome>(domain, {
          local: localRelease,
          remote: {
            kind: FILE_LOCK_OP_KINDS.release,
            payload: {
              owner: ownerId,
              allMine: true,
              coordinationDomain: domain,
              publishedSha: null,
            } satisfies FileLockReleaseParams,
            decode: (raw) => {
              const value = raw as { released?: string[]; heldBefore?: number };
              return {
                released: value.released ?? [],
                heldBefore: typeof value.heldBefore === 'number' ? value.heldBefore : null,
              };
            },
          },
        }),
      );
    } catch {
      // Preserve locks:release's routing fail-open contract: if authority
      // resolution fails, still release through the local store.
      const value = await acquireWithContentionRetry(localRelease);
      routed = { value, via: 'local-authority' as const, scope: undefined };
    }

    const outcome = routed.value;
    released.push(...outcome.released);
    if (domain !== primaryCoordinationDomain && outcome.released.length > 0) {
      crossDomainReleased.push({ coordination_domain: domain, released: outcome.released });
    }
    if (heldBefore !== null && outcome.heldBefore !== null) heldBefore += outcome.heldBefore;
    else if (outcome.heldBefore === null) heldBefore = null;

    if (outcome.released.length > 0) {
      noteShaTokenRelease(domain, outcome.released, null, Date.now());
      notifyPlanLockChange(outcome.released);
      if (routed.via !== 'remote-authority' && routed.scope) {
        emitReleaseLockEvents((event) => void recordLockEvent(event), {
          scope: routed.scope,
          owner: ownerId,
          released: outcome.released,
          ts: Date.now(),
          publishedSha: null,
        });
      }
    }
  }

  // Granular intention locks share the file-lock coordination domain but live
  // in their own table. Sweep them on the same all-owned seam so both an
  // explicit all_mine release and session-end cleanup actually release every
  // path lock family owned by the session.
  for (const domain of fileDomains) {
    const result = await inWorkspaceTxn(domain, ownerId, (tx) =>
      releaseAllGranularForOwner(tx, domain, ownerId),
    );
    granularReleased += result.released;
  }
  if (heldBefore !== null) heldBefore += granularReleased;

  // Named-resource locks use a bounded set of domains by construction. Include
  // the primary domain as well so a packaged/overridden environment cannot
  // strand an ordinary tree-scoped resource when its candidate set differs.
  let resourcesReleased = 0;
  const resourceDomains = [...new Set([primaryCoordinationDomain, ...candidateResourceLockDomains()])];
  for (const domain of resourceDomains) {
    const result = await inWorkspaceTxn(domain, ownerId, (tx) =>
      releaseAllResourcesForOwner(tx, domain, ownerId),
    );
    resourcesReleased += result.released;
    if (source && result.exclusiveResources.length > 0) {
      for (const resource of result.exclusiveResources) {
        await broadcastResourceBackUp({
          source,
          resource,
          waiters: result.waiters[resource] ?? [],
        }).catch(() => {});
      }
    }
  }

  return {
    released,
    heldBefore,
    crossDomainReleased,
    granularReleased,
    resourcesReleased,
  };
}
