/**
 * fleet/nursery — structured concurrency over the spawn tree (papercusp binding).
 *
 * The mechanism (transitive cancel + the completion gate) lives in
 * @papercusp/structured-concurrency's `createNursery`. This module binds it to papercusp:
 * the PG spawn-tree store (`pgSpawnTreeStore`), the real lock-release effect
 * (`releaseAllLocksForOwners`), and a coord cancellation notice. It keeps the historical
 * `cancelSubtree(sql, opts)` entry point + result shape (claimsReleased / planClaimsReleased)
 * the fleet:* tools and the integration suite depend on.
 */
import type { Sql } from 'postgres';
import { createNursery, type CancelNotice } from '@papercusp/structured-concurrency';
import type { CompletionGate, LockReleaser } from '@papercusp/structured-concurrency';
import { pgSpawnTreeStore } from './pg-stores';
import { releaseAllLocksForOwners } from './lock-release';
import { sendMessage } from '../agent-tools/coordination/messages';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

export type { CancelNotice, CancelNotifier } from '@papercusp/structured-concurrency';

export interface CancelSubtreeOptions {
  workspaceId: string;
  rootSpawnId: string;
  reason: string;
  /** Who initiated the cancel — the sender of the coord notice. */
  actor: AgentIdentity;
  /** Override the lock-release effect (tests inject a spy). Default releases real locks. */
  lockReleaser?: LockReleaser;
  /** Override the coord notice (tests inject a spy). Default sends a coord message. */
  notifier?: (notice: CancelNotice) => Promise<void>;
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
  cancelled: CancelledNode[];
  alreadyTerminal: string[];
  /** work-item claims (harness_features_consolidated.taken_by) cleared. */
  claimsReleased: number;
  /** plan_item_claims rows deleted. */
  planClaimsReleased: number;
  /** Lock-release outcome (file + resource locks freed across all owners). */
  locks: { owners: string[]; filePathsReleased: number; resourcesReleased: number };
  /** Owners the coord cancellation notice was pushed to. */
  notified: string[];
}

/** Default coord notice: a durable cancellation message to every cancelled owner. */
export async function defaultNotifier(actor: AgentIdentity, notice: CancelNotice): Promise<void> {
  if (notice.toOwners.length === 0) return;
  await sendMessage(actor, {
    to: notice.toOwners,
    kind: 'message',
    category: 'cancellation',
    summary: `Cancelled (${notice.cancelledSpawnIds.length} agent${notice.cancelledSpawnIds.length === 1 ? '' : 's'}): ${notice.reason}`,
    body: `Your work was cancelled as part of the spawn subtree rooted at ${notice.rootSpawnId}. Stop work, release any holds, and exit. Reason: ${notice.reason}`,
  });
}

/**
 * Cancel a spawn subtree: mark every ACTIVE node cancelled, release its claims + locks
 * NOW, and push a coord cancellation notice to each. Idempotent.
 */
export async function cancelSubtree(sql: Sql, opts: CancelSubtreeOptions): Promise<CancelSubtreeResult> {
  const nursery = createNursery({
    store: pgSpawnTreeStore(sql),
    lockReleaser: opts.lockReleaser ?? releaseAllLocksForOwners,
    notifier: opts.notifier ?? ((n) => defaultNotifier(opts.actor, n)),
  });
  const res = await nursery.cancelSubtree({ workspaceId: opts.workspaceId, rootSpawnId: opts.rootSpawnId, reason: opts.reason });
  return {
    rootSpawnId: res.rootSpawnId,
    cancelled: res.cancelled,
    alreadyTerminal: res.alreadyTerminal,
    claimsReleased: res.resourcesReleased.claims ?? 0,
    planClaimsReleased: res.resourcesReleased.planClaims ?? 0,
    locks: res.locks,
    notified: res.notified,
  };
}

/** The number of ACTIVE descendants under a nursery node (the completion gate input). */
export async function openChildCount(sql: Sql, workspaceId: string, spawnId: string): Promise<number> {
  return pgSpawnTreeStore(sql).openChildren(workspaceId, spawnId);
}

/** The nursery completion gate: a nursery cannot complete while a child lives. */
export async function assertCanComplete(sql: Sql, workspaceId: string, spawnId: string): Promise<CompletionGate> {
  const open = await pgSpawnTreeStore(sql).openChildren(workspaceId, spawnId);
  return { canComplete: open === 0, openChildren: open };
}
