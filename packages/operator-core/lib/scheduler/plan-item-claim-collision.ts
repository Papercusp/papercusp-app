/**
 * Plan-item claim collision detector (agent-trap-guards-2026-07-26 P-006).
 *
 * Incident: a leader was mid-execution on a work-item implementing a plan item
 * that was, at the time, effectively `blocked` (so the scheduler never offered
 * it to anyone else). Once the plan item unblocked, a member's claim-spec
 * auto-claimed it within seconds via the normal self-select path. The
 * collision surfaced only at close time, via a plan-item claim `conflict`,
 * after a whole duplicated-work window had already elapsed.
 *
 * Root cause: holding the linked WORK-ITEM is not holding the PLAN ITEM — the
 * two are separate records with separate ownership (`work_items.assignee` vs
 * `harness_shared.plan_item_claims.owner`), and nothing surfaced the drift
 * between them until someone explicitly tried to claim/convert the plan item
 * and got refused.
 *
 * This closes the "surface it" half of P-006 (the "notify" half lives in
 * plan-items/liveness.ts's `claimPlanItem`, fired the moment the drift is
 * CREATED): given a work-item, check whether its linked plan item is
 * currently held by a LIVE claim whose owner differs from the work-item's own
 * assignee — i.e. someone else now holds the plan item this work-item claims
 * to be executing. Read-only, fails OPEN (null) on any lookup error — this
 * must never wedge work_items:get on a claims-store hiccup.
 */
import type { WorkItem } from '../work-items';
import { resolvePlanItemStamp } from './plan-item-lane-guard';
import { getClaim } from '../plan-items/claims';

export interface PlanItemClaimCollision {
  /** The plan slug the work-item is linked to. */
  planSlug: string;
  /** The specific plan-item id whose live claim diverged from this work-item's assignee. */
  itemId: string;
  /** ownerId of whoever currently holds the LIVE plan-item claim. */
  claimedBy: string;
  claimedByLabel: string | null;
  note: string;
}

/**
 * Does this work-item's linked plan item now have a LIVE claim held by
 * someone OTHER than the work-item's own assignee? Returns null when: the
 * work-item is unassigned, carries no plan-item linkage (neither mechanism —
 * see plan-item-lane-guard.ts's "THE TWO LINKAGE MECHANISMS"), the linked
 * plan item has no live claim, or its live claim's owner matches the
 * work-item's assignee (the common, non-colliding case).
 */
export async function planItemClaimCollision(
  workItem: Pick<WorkItem, 'payload' | 'harness' | 'assignee'> & Partial<Pick<WorkItem, 'id' | 'family'>>,
): Promise<PlanItemClaimCollision | null> {
  if (!workItem.assignee) return null;
  const stamp = await resolvePlanItemStamp(workItem);
  if (!stamp) return null;
  try {
    const { resolvePlanScope } = await import('../agent-tools/plans/source');
    const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: workItem.harness ?? undefined });
    for (const itemId of stamp.item_ids) {
      const claim = await getClaim(workspaceId, harnessSlug, stamp.plan_slug, itemId);
      if (claim && !claim.expired && claim.owner !== workItem.assignee) {
        return {
          planSlug: stamp.plan_slug,
          itemId,
          claimedBy: claim.owner,
          claimedByLabel: claim.ownerLabel,
          note:
            `plan item ${stamp.plan_slug}#${itemId} — which this work-item implements — is now held by a LIVE claim ` +
            `from ${claim.ownerLabel ?? claim.owner}, not this work-item's assignee. Holding the linked work-item is ` +
            `not holding the plan item: coordinate with them before continuing to avoid duplicated work.`,
        };
      }
    }
    return null;
  } catch {
    return null; // fail OPEN — a claims-store hiccup must never wedge work_items:get
  }
}
