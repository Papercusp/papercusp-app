/**
 * work-item-claim-authority-ops — the AUTHORITY-side execution of work-item CLAIM ops
 * (decentralized-dispatch-scaling-2026-06-08 Phase 1, P-004 / D-002).
 *
 * When a Swarm resolves a REMOTE per-Hive authority for a work item and routes a claim
 * acquire/heartbeat/release there (acquireClaim → getWorkItemClaimAuthority().route →
 * the real Track-B router → PeerRpcTransport → the authority peer), the authority must
 * RUN that op against ITS local claim store, on the requesting Swarm's behalf (owner =
 * the remote peer's owner id, carried in the payload). This module registers the
 * handlers for the `work-item.claim.acquire` / `.heartbeat` / `.release` op kinds.
 *
 * Mirrors `plan-items/plan-item-claim-authority-ops.ts` exactly: bind a minimal
 * `WorkItemClaimCoordinator` SEAM rather than reach for the store directly, so the
 * handlers are fully testable with a fake coordinator and the receiving side stays
 * decoupled from the store's exact surface. The default coordinator is the real claim
 * store's `*Local` functions (the un-routed SQL leg).
 *
 * Distinct op kinds from the plan-item (`plan-item.claim.*`) + file-lock (`lock.*`)
 * handlers — registerAuthorityOp throws on a duplicate kind, so a clash surfaces at boot.
 */

import { registerAuthorityOp, registeredAuthorityOpKinds } from './authority';
import {
  acquireClaimLocal,
  heartbeatClaimLocal,
  releaseClaimLocal,
  releaseClaimForItemLocal,
  refusedAcquire,
  WORK_ITEM_CLAIM_OP_KINDS,
  type AcquireOpts,
  type AcquireResult,
  type HeartbeatClaimParams,
  type HeartbeatResult,
  type ReleaseClaimParams,
  type ReleaseClaimForItemParams,
} from './work-item-claims';
import { loadRevokedPubkeys } from './sync/hyperbee/load-revoked-pubkeys';

/**
 * The minimal claim-store surface the authority ops drive. The default binds the real
 * `*Local` SQL fns; tests inject a fake (or a real-PG-backed) coordinator.
 */
export interface WorkItemClaimCoordinator {
  acquire(opts: AcquireOpts): Promise<AcquireResult>;
  heartbeat(p: HeartbeatClaimParams): Promise<HeartbeatResult>;
  release(p: ReleaseClaimParams): Promise<boolean>;
  releaseForItem(p: ReleaseClaimForItemParams): Promise<boolean>;
}

/** The production coordinator: the un-routed claim-store SQL legs. */
export const DEFAULT_WORK_ITEM_CLAIM_COORDINATOR: WorkItemClaimCoordinator = {
  acquire: acquireClaimLocal,
  heartbeat: heartbeatClaimLocal,
  release: releaseClaimLocal,
  releaseForItem: releaseClaimForItemLocal,
};

function asAcquireOpts(payload: unknown): AcquireOpts {
  const p = payload as Partial<AcquireOpts>;
  if (
    !p ||
    typeof p.workspaceId !== 'string' ||
    typeof p.harnessSlug !== 'string' ||
    typeof p.workItemId !== 'string' ||
    typeof p.owner !== 'string'
  ) {
    throw new Error('work-item.claim.acquire: invalid payload (workspaceId, harnessSlug, workItemId, owner required)');
  }
  return p as AcquireOpts;
}

function asHeartbeatParams(payload: unknown): HeartbeatClaimParams {
  const p = payload as Partial<HeartbeatClaimParams>;
  if (
    !p ||
    typeof p.workspaceId !== 'string' ||
    typeof p.harnessSlug !== 'string' ||
    typeof p.workItemId !== 'string' ||
    typeof p.claimId !== 'string' ||
    typeof p.owner !== 'string'
  ) {
    throw new Error('work-item.claim.heartbeat: invalid payload (workspaceId, harnessSlug, workItemId, claimId, owner required)');
  }
  return p as HeartbeatClaimParams;
}

function asReleaseParams(payload: unknown): ReleaseClaimParams {
  const p = payload as Partial<ReleaseClaimParams>;
  if (
    !p ||
    typeof p.workspaceId !== 'string' ||
    typeof p.harnessSlug !== 'string' ||
    typeof p.workItemId !== 'string' ||
    typeof p.claimId !== 'string' ||
    typeof p.owner !== 'string'
  ) {
    throw new Error('work-item.claim.release: invalid payload (workspaceId, harnessSlug, workItemId, claimId, owner required)');
  }
  return p as ReleaseClaimParams;
}

function asReleaseForItemParams(payload: unknown): ReleaseClaimForItemParams {
  const p = payload as Partial<ReleaseClaimForItemParams>;
  if (
    !p ||
    typeof p.workspaceId !== 'string' ||
    typeof p.harnessSlug !== 'string' ||
    typeof p.workItemId !== 'string' ||
    typeof p.owner !== 'string'
  ) {
    throw new Error('work-item.claim.release-for-item: invalid payload (workspaceId, harnessSlug, workItemId, owner required)');
  }
  return p as ReleaseClaimForItemParams;
}

/**
 * Register the work-item claim authority op handlers against `coordinator`. Call ONCE at
 * boot (from the work_items tool barrel). Idempotent: a no-op if the kinds are already
 * registered (the global registry is reset between tests, so a re-run after a reset
 * re-registers cleanly). Each handler validates the payload, then runs the op locally on
 * THIS (the authority's) store.
 */
/** The scope a caller-standing check judges against (from the op payload). */
export interface CallerStandingScope {
  workspaceId: string;
  harnessSlug: string;
  potSlug?: string | null;
}

/**
 * Is `holderPubkey` REVOKED for this scope? (EI-284.) The authority-side gate
 * on claim acquire/heartbeat — registered per boot via
 * {@link registerWorkItemClaimAuthorityOps} opts; the default consults the
 * durable revocation source (`harness_shared.contributors.revoked_pubkeys`,
 * the same set the substrate's announce-time refusal is seeded from).
 */
export type IsCallerRevoked = (holderPubkey: string, scope: CallerStandingScope) => Promise<boolean>;

/**
 * The production standing check. FAIL-OPEN posture (D-004): only an
 * AFFIRMATIVE "this pubkey is in the revoked set" refuses — an unreadable
 * store or an empty set allows, so a PG blip can never wedge legitimate
 * cross-swarm claims.
 */
export const defaultIsCallerRevoked: IsCallerRevoked = async (holderPubkey, scope) => {
  try {
    const revoked = await loadRevokedPubkeys({
      workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug,
    });
    return revoked.has(holderPubkey);
  } catch {
    return false; // fail-open: standing unknowable ≠ revoked
  }
};

export interface WorkItemClaimAuthorityOpsOpts {
  /** Override the standing check (tests / rigs whose holder-pubkey domain
   *  differs from the announce/device domain). Default: the durable
   *  revoked-set check. */
  isCallerRevoked?: IsCallerRevoked;
}

/**
 * Register the work-item claim authority op handlers against `coordinator`. Call ONCE at
 * boot (from the work_items tool barrel). Idempotent: a no-op if the kinds are already
 * registered (the global registry is reset between tests, so a re-run after a reset
 * re-registers cleanly). Each handler validates the payload, then runs the op locally on
 * THIS (the authority's) store.
 *
 * CALLER-STANDING GATE (EI-284): acquire + heartbeat first check the payload's
 * `holderPubkey` against the hive's revoked set — a revoked swarm's RPC can no
 * longer win (or extend) a lease and block live swarms until lapse. Release is
 * deliberately NOT gated: a revoked holder relinquishing its lease is exactly
 * what the hive wants. LIMITS (documented, not silent): the envelope is
 * unauthenticated today, so `holderPubkey` is self-reported — this is
 * defense-in-depth against well-behaved-but-revoked peers, not against a
 * malicious caller lying about its identity (the authenticated-envelope
 * follow-on lives on EI-284's thread); and a payload WITHOUT a holderPubkey
 * skips the check (no identity to judge — fail-open, D-004).
 */
export function registerWorkItemClaimAuthorityOps(
  coordinator: WorkItemClaimCoordinator = DEFAULT_WORK_ITEM_CLAIM_COORDINATOR,
  opts: WorkItemClaimAuthorityOpsOpts = {},
): void {
  if (registeredAuthorityOpKinds().includes(WORK_ITEM_CLAIM_OP_KINDS.acquire)) return;
  const isRevoked = opts.isCallerRevoked ?? defaultIsCallerRevoked;

  registerAuthorityOp(WORK_ITEM_CLAIM_OP_KINDS.acquire, async (payload) => {
    const p = asAcquireOpts(payload);
    if (p.holderPubkey && (await isRevoked(p.holderPubkey, p))) {
      return refusedAcquire(p);
    }
    return coordinator.acquire(p);
  });
  registerAuthorityOp(WORK_ITEM_CLAIM_OP_KINDS.heartbeat, async (payload) => {
    const p = asHeartbeatParams(payload);
    if (p.holderPubkey && (await isRevoked(p.holderPubkey, p))) {
      return {
        renewed: false,
        held: false,
        expiresTs: null,
        reason: 'caller_revoked',
      } satisfies HeartbeatResult;
    }
    return coordinator.heartbeat(p);
  });
  registerAuthorityOp(WORK_ITEM_CLAIM_OP_KINDS.release, async (payload) =>
    coordinator.release(asReleaseParams(payload)),
  );
  // EI-6832: same "release is deliberately NOT gated" posture as the claimId-checked
  // release above — a stale lease being cleared as its item returns to the pool is
  // exactly what the hive wants, never something a revoked holder should be blocked from.
  registerAuthorityOp(WORK_ITEM_CLAIM_OP_KINDS.releaseForItem, async (payload) =>
    coordinator.releaseForItem(asReleaseForItemParams(payload)),
  );
}
