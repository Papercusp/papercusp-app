/**
 * Release a work-item's LINKED PLAN LANE alongside the work-item itself
 * (fleet-leadership-continuity-and-actuation-2026-08-01 P-006).
 *
 * Holding a work-item is not holding its plan item: `work_items.assignee` and
 * `harness_shared.plan_item_claims.owner` are separate records with separate ownership
 * (the duality documented in scheduler/plan-item-claim-collision.ts). Releasing one
 * therefore left the other held, and the resulting half-released pair is worse than
 * either state on its own — it is the divergence the whole of Phase 2 exists to remove.
 *
 * The damaging direction is specifically WORK-ITEM-FREED-FIRST: the row returns to the
 * claimable pool while the plan lane still names the departed holder, so the next agent
 * claims the work-item and instantly collides with a lane it cannot take. That is not
 * hypothetical — it is the incident behind agent-trap-guards-2026-07-26 P-006, where the
 * collision surfaced only at close time, after a full duplicated-work window.
 *
 * ORDERING IS THE MECHANISM, and it is chosen deliberately over a claim of atomicity we
 * cannot honestly make: the two stores are written through different code paths (the plan
 * claim is routed through the claim AUTHORITY, which may be a REMOTE peer — see
 * claims.ts's `getClaimAuthority().route`), so a single SQL transaction spanning both does
 * not exist to be used. What we can guarantee is WHICH half-state is reachable. Releasing
 * the lane FIRST means a mid-way failure leaves: lane free, work-item still held by ME —
 * recoverable, because the holder is still the holder and can retry. The reverse order
 * leaves the unrecoverable one, where a peer is already colliding. So the failure mode is
 * downgraded from "a peer duplicates work" to "I retry my own release".
 *
 * The residue is also self-healing rather than permanent: plan-item claims are TTL-leased
 * (`claim.expired`, `sweepLapsedClaims` in plan-items/stale-claims.ts), so a lane that
 * survives a failed release lapses on its own, and P-007's claim-time collision warning
 * covers the window until it does.
 *
 * Only ever releases claims held by the RELEASING owner. A lane held by someone else is a
 * peer's live work and is left strictly untouched — this must never become a way to knock
 * another agent off their claim.
 *
 * Fail-soft by contract: a claims-store hiccup must not wedge a work-item release, because
 * this same path carries the stale-claim reaper and the SessionEnd force-release. It
 * reports what it freed and swallows what it could not.
 */
import type { WorkItem } from '../work-items';
import { resolvePlanItemStamp } from '../scheduler/plan-item-lane-guard';
import { getClaim, releaseClaim } from './claims';

export interface LinkedLaneRelease {
  planSlug: string;
  /** Plan-item ids whose lane claim was actually freed by this call. */
  released: string[];
  /** Lane claims held by the releasing owner that could NOT be freed (store error). */
  failed: string[];
}

/**
 * Free the plan-lane claims the releasing holder owns on the work-item's linked plan items.
 *
 * Returns null when there is nothing to do: no releasing owner, no plan linkage, or no live
 * lane claim owned by them. Never throws.
 */
export async function releaseLinkedPlanLane(
  workItem: Pick<WorkItem, 'payload' | 'harness'> & Partial<Pick<WorkItem, 'id' | 'family'>>,
  releasingOwner: string | null | undefined,
): Promise<LinkedLaneRelease | null> {
  if (!releasingOwner) return null;
  try {
    const stamp = await resolvePlanItemStamp(workItem);
    if (!stamp) return null;
    const { resolvePlanScope } = await import('../agent-tools/plans/source');
    const { workspaceId, harnessSlug } = await resolvePlanScope({
      harnessSlug: workItem.harness ?? undefined,
    });
    const released: string[] = [];
    const failed: string[] = [];
    for (const itemId of stamp.item_ids) {
      try {
        const claim = await getClaim(workspaceId, harnessSlug, stamp.plan_slug, itemId);
        // Untouched unless it is a LIVE claim owned by the agent doing the releasing.
        // An expired one is already effectively free; a peer's is theirs.
        if (!claim || claim.expired || claim.owner !== releasingOwner) continue;
        const ok = await releaseClaim(
          workspaceId,
          harnessSlug,
          stamp.plan_slug,
          itemId,
          claim.claimId,
          releasingOwner,
        );
        (ok ? released : failed).push(itemId);
      } catch {
        failed.push(itemId); // one bad lane must not abandon the rest
      }
    }
    if (released.length === 0 && failed.length === 0) return null;
    return { planSlug: stamp.plan_slug, released, failed };
  } catch {
    return null; // fail OPEN — never wedge a release (reaper + SessionEnd route through here)
  }
}
