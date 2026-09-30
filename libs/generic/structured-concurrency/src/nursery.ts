/**
 * nursery — structured concurrency over the spawn tree.
 *
 * THE INVERSION. In the unstructured model an orphaned task is a leak that a heartbeat
 * lease eventually GCs. Here a spawn node is a NURSERY that owns its descendants:
 *
 *   • cancelSubtree — the missing primitive: a cancel/abort fans transitively DOWN the
 *     entire subtree and releases each descendant's locks + resources IMMEDIATELY,
 *     instead of waiting for N independent leases to expire. The lease stays as the
 *     FALLBACK crash-detector, not the lifecycle owner.
 *
 *   • assertCanComplete / openChildCount — the completion gate: a nursery cannot be
 *     marked done while a child still lives.
 *
 * The durable mutations (status + resource releases) are ONE atomic store operation
 * (`cancelActiveSubtree`). The lock release and the notification are fail-open effects
 * AFTER that commit — locks are efficiency-class; a missed one falls back to its lease.
 */
import type { CompletionGate, SpawnNode } from './types';
import type {
  CancelNotice,
  CancelNotifier,
  LockReleaser,
  LockReleaseResult,
  LockTarget,
  SpawnTreeStore,
} from './ports';

export interface NurseryDeps {
  store: SpawnTreeStore;
  /** Release a cancelled subtree's locks NOW (default: no-op — locks fall back to their lease). */
  lockReleaser?: LockReleaser;
  /** Push a cancellation notice to each cancelled owner (default: no-op). */
  notifier?: CancelNotifier;
}

export interface CancelledNode {
  spawnId: string;
  sessionOwner: string | null;
  featureId: string | null;
  harnessSlug: string | null;
  planSlug: string | null;
  itemId: string | null;
}

export interface CancelSubtreeResult {
  rootSpawnId: string;
  /** Active nodes that were transitioned to cancelled. */
  cancelled: CancelledNode[];
  /** Nodes already terminal when cancellation ran (left untouched). */
  alreadyTerminal: string[];
  /** Host-defined tally of resources released atomically with the cancel (e.g. claims). */
  resourcesReleased: Record<string, number>;
  /** Lock-release outcome (file + resource locks freed across all owners). */
  locks: LockReleaseResult;
  /** Owners the cancellation notice was pushed to. */
  notified: string[];
}

const NO_LOCKS: LockReleaseResult = { owners: [], filePathsReleased: 0, resourcesReleased: 0 };

function toCancelledNode(n: SpawnNode): CancelledNode {
  return {
    spawnId: n.spawnId,
    sessionOwner: n.sessionOwner,
    featureId: n.featureId,
    harnessSlug: n.harnessSlug,
    planSlug: n.planSlug,
    itemId: n.itemId,
  };
}

export interface Nursery {
  cancelSubtree(opts: { workspaceId: string; rootSpawnId: string; reason: string }): Promise<CancelSubtreeResult>;
  openChildCount(workspaceId: string, spawnId: string): Promise<number>;
  assertCanComplete(workspaceId: string, spawnId: string): Promise<CompletionGate>;
}

export function createNursery(deps: NurseryDeps): Nursery {
  const { store } = deps;

  async function cancelSubtree(opts: { workspaceId: string; rootSpawnId: string; reason: string }): Promise<CancelSubtreeResult> {
    // ── Phase 1: the atomic durable mutation (status + resource releases). ──────────
    const inner = await store.cancelActiveSubtree(opts);
    const cancelledNodes = inner.cancelled;

    // ── Phase 2: fail-open cross-substrate / coord effects (after commit). ──────────
    const owners = [...new Set(cancelledNodes.map((n) => n.sessionOwner).filter((o): o is string => !!o))];
    const targets: LockTarget[] = [
      ...new Map(
        cancelledNodes
          .filter((n) => n.sessionOwner)
          .map((n) => [`${n.coordinationDomain} ${n.sessionOwner}`, { coordinationDomain: n.coordinationDomain, owner: n.sessionOwner! }]),
      ).values(),
    ];

    let locks: LockReleaseResult = NO_LOCKS;
    if (targets.length > 0 && deps.lockReleaser) {
      locks = await deps.lockReleaser(targets);
    }

    let notified: string[] = [];
    if (owners.length > 0 && cancelledNodes.length > 0 && deps.notifier) {
      const notice: CancelNotice = {
        toOwners: owners,
        rootSpawnId: opts.rootSpawnId,
        reason: opts.reason,
        cancelledSpawnIds: cancelledNodes.map((c) => c.spawnId),
      };
      await deps.notifier(notice);
      notified = owners;
    }

    return {
      rootSpawnId: opts.rootSpawnId,
      cancelled: cancelledNodes.map(toCancelledNode),
      alreadyTerminal: inner.alreadyTerminal,
      resourcesReleased: inner.resourcesReleased,
      locks,
      notified,
    };
  }

  async function openChildCount(workspaceId: string, spawnId: string): Promise<number> {
    return store.openChildren(workspaceId, spawnId);
  }

  async function assertCanComplete(workspaceId: string, spawnId: string): Promise<CompletionGate> {
    const open = await store.openChildren(workspaceId, spawnId);
    return { canComplete: open === 0, openChildren: open };
  }

  return { cancelSubtree, openChildCount, assertCanComplete };
}
