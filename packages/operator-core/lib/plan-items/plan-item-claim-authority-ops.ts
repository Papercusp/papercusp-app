/**
 * plan-item-claim-authority-ops — the AUTHORITY-side execution of plan-item CLAIM
 * ops (Phase 1/Phase 4 of plan-item-assignment-claim-liveness-2026-06-04).
 *
 * When a peer resolves a REMOTE authority for a harness and routes a plan-item claim
 * acquire/heartbeat/release there (acquireClaim → ClaimAuthority.route →
 * routeToAuthority → PeerRpcTransport → POST /api/authority/rpc → handleAuthorityRpc),
 * the authority must RUN that op against ITS local claim store, on the requesting
 * peer's behalf (owner = the remote peer's owner id, carried in the payload). This
 * module registers the handlers for the `plan-item.claim.acquire` / `.heartbeat` /
 * `.release` op kinds.
 *
 * It mirrors su-584a8's file-lock-authority-ops.ts exactly: bind a minimal
 * `PlanItemClaimCoordinator` SEAM rather than reach for the store directly, so the
 * handlers are fully testable with a fake coordinator and the receiving side stays
 * decoupled from the store's exact surface. The default coordinator is the real
 * claim store's `*Local` functions (the un-routed SQL leg).
 *
 * The cross-machine model: peer A (non-authority) wants the claim on item X → RPCs
 * authority B → B's store records X held by A → A's later heartbeat/release RPCs B
 * again. B's single store (its PK on (workspace, harness, plan, item)) is the
 * serialization point — proven by plan-item-claim-two-instance.integration.test.ts.
 */

import { registerAuthorityOp, registeredAuthorityOpKinds } from '../authority';
import {
  acquireClaimLocal,
  heartbeatClaimLocal,
  releaseClaimLocal,
  forceReleaseClaimLocal,
  forceTakeoverClaimLocal,
  PLAN_ITEM_CLAIM_OP_KINDS,
  type AcquireOpts,
  type AcquireResult,
  type HeartbeatClaimParams,
  type HeartbeatResult,
  type ReleaseClaimParams,
  type ForceReleaseClaimParams,
  type ForceTakeoverClaimParams,
} from './claims';

/**
 * The minimal claim-store surface the authority ops drive. The default binds the
 * real `*Local` SQL fns; tests inject a fake (or a real-PG-backed) coordinator.
 */
export interface PlanItemClaimCoordinator {
  acquire(opts: AcquireOpts): Promise<AcquireResult>;
  heartbeat(p: HeartbeatClaimParams): Promise<HeartbeatResult>;
  release(p: ReleaseClaimParams): Promise<boolean>;
}

/** The production coordinator: the un-routed claim-store SQL legs. */
export const DEFAULT_PLAN_ITEM_CLAIM_COORDINATOR: PlanItemClaimCoordinator = {
  acquire: acquireClaimLocal,
  heartbeat: heartbeatClaimLocal,
  release: releaseClaimLocal,
};

function asAcquireOpts(payload: unknown): AcquireOpts {
  const p = payload as Partial<AcquireOpts>;
  if (
    !p ||
    typeof p.workspaceId !== 'string' ||
    typeof p.harnessSlug !== 'string' ||
    typeof p.planSlug !== 'string' ||
    typeof p.itemId !== 'string' ||
    typeof p.owner !== 'string'
  ) {
    throw new Error('plan-item.claim.acquire: invalid payload (workspaceId, harnessSlug, planSlug, itemId, owner required)');
  }
  return p as AcquireOpts;
}

function asHeartbeatParams(payload: unknown): HeartbeatClaimParams {
  const p = payload as Partial<HeartbeatClaimParams>;
  if (
    !p ||
    typeof p.workspaceId !== 'string' ||
    typeof p.harnessSlug !== 'string' ||
    typeof p.planSlug !== 'string' ||
    typeof p.itemId !== 'string' ||
    typeof p.claimId !== 'string' ||
    typeof p.owner !== 'string'
  ) {
    throw new Error('plan-item.claim.heartbeat: invalid payload (workspaceId, harnessSlug, planSlug, itemId, claimId, owner required)');
  }
  return p as HeartbeatClaimParams;
}

function asReleaseParams(payload: unknown): ReleaseClaimParams {
  const p = payload as Partial<ReleaseClaimParams>;
  if (
    !p ||
    typeof p.workspaceId !== 'string' ||
    typeof p.harnessSlug !== 'string' ||
    typeof p.planSlug !== 'string' ||
    typeof p.itemId !== 'string' ||
    typeof p.claimId !== 'string' ||
    typeof p.owner !== 'string'
  ) {
    throw new Error('plan-item.claim.release: invalid payload (workspaceId, harnessSlug, planSlug, itemId, claimId, owner required)');
  }
  return p as ReleaseClaimParams;
}

function asForceReleaseParams(payload: unknown): ForceReleaseClaimParams {
  return asReleaseParams(payload);
}

function asForceTakeoverParams(payload: unknown): ForceTakeoverClaimParams {
  const p = payload as Partial<ForceTakeoverClaimParams>;
  if (
    !p ||
    typeof p.workspaceId !== 'string' ||
    typeof p.harnessSlug !== 'string' ||
    typeof p.planSlug !== 'string' ||
    typeof p.itemId !== 'string' ||
    typeof p.owner !== 'string' ||
    typeof p.expectedClaimId !== 'string' ||
    typeof p.expectedOwner !== 'string'
  ) {
    throw new Error(
      'plan-item.claim.force-takeover: invalid payload (workspaceId, harnessSlug, planSlug, itemId, owner, expectedClaimId, expectedOwner required)',
    );
  }
  return p as ForceTakeoverClaimParams;
}

/**
 * Register the plan-item claim authority op handlers against `coordinator`. Call
 * ONCE at boot (from the plan-items tool barrel). Idempotent: a no-op if the kinds
 * are already registered (the global registry is reset between tests, so a re-run
 * after a reset re-registers cleanly). Each handler validates the payload, then runs
 * the op locally on THIS (the authority's) store.
 */
export function registerPlanItemClaimAuthorityOps(
  coordinator: PlanItemClaimCoordinator = DEFAULT_PLAN_ITEM_CLAIM_COORDINATOR,
): void {
  if (registeredAuthorityOpKinds().includes(PLAN_ITEM_CLAIM_OP_KINDS.acquire)) return;

  registerAuthorityOp(PLAN_ITEM_CLAIM_OP_KINDS.acquire, async (payload) =>
    coordinator.acquire(asAcquireOpts(payload)),
  );
  registerAuthorityOp(PLAN_ITEM_CLAIM_OP_KINDS.heartbeat, async (payload) =>
    coordinator.heartbeat(asHeartbeatParams(payload)),
  );
  registerAuthorityOp(PLAN_ITEM_CLAIM_OP_KINDS.release, async (payload) =>
    coordinator.release(asReleaseParams(payload)),
  );
  registerAuthorityOp(PLAN_ITEM_CLAIM_OP_KINDS.forceRelease, async (payload) =>
    forceReleaseClaimLocal(asForceReleaseParams(payload)),
  );
  registerAuthorityOp(PLAN_ITEM_CLAIM_OP_KINDS.forceTakeover, async (payload) =>
    forceTakeoverClaimLocal(asForceTakeoverParams(payload)),
  );
}
