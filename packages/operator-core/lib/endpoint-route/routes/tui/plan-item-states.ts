/**
 * GET /api/tui/plan-item-states?harness=<slug>&plan=<slug>
 *
 * The read surface for P-005a (tui-workbench-ratatui-2026-06-04): per plan item,
 * its merged ASSIGNMENT + live CLAIM + LIVENESS disposition, so `pui` (apps/tui)
 * can show "who's on this item" in the Plans view. A thin HTTP seam over the
 * settled plan-item lib (plan-item-assignment-claim-liveness-2026-06-04):
 * `mergedPlanItemStates` (assignment ⋈ claim → disposition) + `harnessLivenessMode`
 * (the LOCAL=availability vs SHARED=activity split, P-005 surface 2).
 *
 * Read-only: this route does NOT claim/assign — those are RFC-decision-gated
 * interactive surfaces (P-005b: claim-from-TUI work-group policy + spawn-to-pane),
 * deferred while project-centric-harness-rethink is still being audited. Workspace
 * is resolved via `resolvePlanScope` — the SAME scope the plan_items:* tools write,
 * so the read lines up with the writes. `auth: 'public'` mirrors the sibling
 * /api/tui/* + /api/coord/* routes (loopback-protected by the host bind).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { resolvePlanScope } from '../../../agent-tools/plans/source';
import {
  mergedPlanItemStates,
  harnessLivenessMode,
  type ImplementingWorkItemState,
  type MergedPlanItemState,
  type PlanItemDisposition,
} from '../../../plan-items/liveness';
import type { LivenessMode } from '../../../plan-items/claims';

/** One per-item row, flattened from the merged assignment+claim view for the TUI. */
export interface PlanItemStateDto {
  itemId: string;
  /** The plan item's effective status (todo/wip/…); null if the record is an orphan (not in the plan). */
  itemStatus: string | null;
  /** Plan-item ids this row directly depends on. */
  blockedBy: string[];
  inPlan: boolean;
  disposition: PlanItemDisposition;
  /** Durable assignment (the stable agent-NAME the item belongs to), or null if pooled. */
  assigneeName: string | null;
  /** Live claim holder's display label (ownerLabel ?? owner), or null if no live claim. */
  claimOwner: string | null;
  /** Stable live-claim owner id, used to join fleet context pressure. */
  claimOwnerId: string | null;
  /** Live claim holder's agent-NAME (how it lines up with the assignment), or null. */
  claimOwnerName: string | null;
  /** Live claim's declared intent, or null. */
  claimIntent: string | null;
  /** Live claim's liveness mode — availability (LOCAL) vs activity (SHARED), or null. */
  claimLivenessMode: LivenessMode | null;
  /** Live claim's lease expiry (ISO), or null. */
  claimExpiresTs: string | null;
  /** Linked plan-item execution record, including any claim-hold provenance. */
  implementingWorkItem: ImplementingWorkItemState | null;
}

export interface PlanItemStatesDto {
  harness: string;
  plan: string;
  /** Whether claims on this harness lease on availability (LOCAL) or activity (SHARED) — P-005 surface 2. */
  harnessLivenessMode: LivenessMode;
  items: PlanItemStateDto[];
}

/**
 * Pure shaper: merged lib states → the flat TUI DTO. Separated from the handler so
 * it's exhaustively unit-testable without a DB or a running operator.
 */
export function shapePlanItemStates(
  harness: string,
  plan: string,
  mode: LivenessMode,
  states: MergedPlanItemState[],
): PlanItemStatesDto {
  return {
    harness,
    plan,
    harnessLivenessMode: mode,
    items: states.map((s) => ({
      itemId: s.itemId,
      itemStatus: s.itemStatus,
      blockedBy: s.blockedBy,
      inPlan: s.inPlan,
      disposition: s.disposition,
      assigneeName: s.assignment?.assigneeName ?? null,
      claimOwner: s.claim ? (s.claim.ownerLabel ?? s.claim.owner) : null,
      claimOwnerId: s.claim?.owner ?? null,
      claimOwnerName: s.claim?.ownerName ?? null,
      claimIntent: s.claim?.intent && s.claim.intent.trim() ? s.claim.intent : null,
      claimLivenessMode: s.claim?.livenessMode ?? null,
      claimExpiresTs: s.claim?.expiresTs ?? null,
      implementingWorkItem: s.implementingWorkItem ?? null,
    })),
  };
}

export default defineTool({
  method: 'GET',
  path: '/tui/plan-item-states',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const harness = url.searchParams.get('harness')?.trim();
    const plan = url.searchParams.get('plan')?.trim();
    if (!harness) return Response.json({ error: 'harness_required: pass ?harness=<slug>' }, { status: 400 });
    if (!plan) return Response.json({ error: 'plan_required: pass ?plan=<slug>' }, { status: 400 });

    const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: harness });
    const [states, mode] = await Promise.all([
      mergedPlanItemStates(workspaceId, harnessSlug, plan),
      harnessLivenessMode(workspaceId, harnessSlug),
    ]);
    return Response.json(shapePlanItemStates(harnessSlug, plan, mode, states));
  },
});
