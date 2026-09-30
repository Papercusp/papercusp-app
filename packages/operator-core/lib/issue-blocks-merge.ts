/**
 * issue-blocks merge — projects open blocking issues onto plan items
 * (engineer-issues-2026-06-03, Phase 2 / D-005).
 *
 * An issue blocks a plan item via a coord_links edge (rel='blocks',
 * src=issue:<id>, dst=plan_item:'<plan_slug>#<item_id>'), written by issues:link.
 * The edge is NOT in plan markdown — closing the issue unblocks every target
 * atomically (one row flip). This reads those edges + the issues' Lifecycle state
 * and returns the item ids with ≥1 OPEN blocking issue, so the plans:* operator
 * readers (plans:get/list/items) can override an item's effectiveStatus
 * todo→blocked AFTER the pure resolver runs — the exact post-resolution merge
 * pattern plans:get already uses for feature-links. The pure @papercusp/plan-parser
 * resolver is UNCHANGED; this merge lives only at the operator call-site.
 *
 * WORKSPACE SCOPING (EI-2760): the coord_links edge is SUBSTRATE data on the coord
 * workspace (DEFAULT_COORD_WORKSPACE while COORD_PER_WORKSPACE is off); the engineer_issues
 * ROW it joins for Lifecycle state is DOMAIN data on the issue scope, which may be a
 * different (per-)workspace. EI-<n> ids are GLOBALLY unique, so the row join keys on the
 * global issue_id WITHOUT a workspace filter — pinning it to the coord workspace silently
 * dropped every block when issues lived in a non-'default' workspace.
 *
 * Wiring status:
 *  - PLAN side: WIRED. plans:get overlays via overlayIssueBlocksForPlan; plans:list
 *    + plans:items hoist getAllBlockedPlanItems() out of their loop and overlay via
 *    applyPlanItemBlocks (so an issue-blocked item flips to effectiveStatus='blocked',
 *    drops out of `actionable`, and is found by `status:'blocked'`). plan_item refs
 *    are '<slug>#<item>' — globally unique, so the overlay is collision-safe.
 *  - FEATURE side: WIRED at the reader. The block-ref is now harness-qualified
 *    (featureRef '<harness>#<feature_id>' — a feature's identity is (harness, id)
 *    everywhere), so issues:link validates a qualified ref and getBlockedFeatures keys
 *    on it; harness:list_features annotates each feature with blockedByIssues (so
 *    blocking a feature is no longer a no-op). The orchestrator-frontier DISPATCH-GATING
 *    (D-006 #3 — don't pick a blocked feature) stays deferred: it depends on the
 *    still-being-designed assignment/claim/liveness model (project-centric-harness-rethink
 *    companion plans), so building it now would be redone.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

export const PLAN_ITEM_KIND = 'plan_item';
export const FEATURE_KIND = 'feature';

/** The coord_links dst_ref for a plan item: '<plan_slug>#<item_id>'. */
export function planItemRef(planSlug: string, itemId: string): string {
  return `${planSlug}#${itemId}`;
}

/**
 * The coord_links dst_ref for a feature: '<harness_slug>#<feature_id>'. A feature's
 * identity is (harness_slug, feature_id) everywhere (the harness_features PK), so the
 * block edge MUST carry the harness — a bare 'F-NNN' is not unique across harnesses and
 * would mis-attribute a block to the same id in another project. Mirrors planItemRef.
 */
export function featureRef(harnessSlug: string, featureId: string): string {
  return `${harnessSlug}#${featureId}`;
}

/** True iff `ref` is a harness-qualified feature ref ('<harness>#<feature_id>', one '#', both sides non-empty). */
export function isQualifiedFeatureRef(ref: string): boolean {
  const i = ref.indexOf('#');
  return i > 0 && i < ref.length - 1 && ref.indexOf('#', i + 1) === -1;
}

export interface BlockingInfo {
  /** item id (e.g. 'P-003') → the open blocking issue ids. Absent = not blocked. */
  blockedItems: Map<string, string[]>;
}

/**
 * For one plan, the items that have ≥1 OPEN blocking issue + which issues block
 * them. A resolved/closed issue no longer blocks. Pure read over PG.
 */
export async function getBlockingIssuesForPlan(planSlug: string): Promise<BlockingInfo> {
  const { sql } = getOrgPg();
  const rows = await sql<{ dst_ref: string; issue_id: string }[]>`
    SELECT l.dst_ref, l.src_ref AS issue_id
      FROM harness_shared.coord_links l
      JOIN harness_shared.engineer_issues i
        ON i.issue_id = l.src_ref
     WHERE l.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND l.rel = 'blocks'
       AND l.src_kind = 'issue'
       AND l.dst_kind = ${PLAN_ITEM_KIND}
       AND l.dst_ref LIKE ${planSlug + '#%'}
       AND i.state = 'open'
     ORDER BY l.src_ref`;
  const blockedItems = new Map<string, string[]>();
  const prefix = `${planSlug}#`;
  for (const r of rows) {
    if (!r.dst_ref.startsWith(prefix)) continue;
    const itemId = r.dst_ref.slice(prefix.length);
    const arr = blockedItems.get(itemId) ?? [];
    arr.push(r.issue_id);
    blockedItems.set(itemId, arr);
  }
  return { blockedItems };
}

/**
 * Every blocked plan item across ALL plans, keyed by the full coord_links
 * dst_ref ('<plan_slug>#<item_id>') → open blocking issue ids. ONE query, so the
 * multi-plan readers (plans:list, plans:items over all plans) hoist this out of
 * their plan loop instead of issuing a per-plan query (N+1). Pure read over PG.
 */
export async function getAllBlockedPlanItems(): Promise<Map<string, string[]>> {
  const { sql } = getOrgPg();
  const rows = await sql<{ dst_ref: string; issue_id: string }[]>`
    SELECT l.dst_ref, l.src_ref AS issue_id
      FROM harness_shared.coord_links l
      JOIN harness_shared.engineer_issues i
        ON i.issue_id = l.src_ref
     WHERE l.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND l.rel = 'blocks'
       AND l.src_kind = 'issue'
       AND l.dst_kind = ${PLAN_ITEM_KIND}
       AND i.state = 'open'
     ORDER BY l.src_ref`;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const arr = out.get(r.dst_ref) ?? [];
    arr.push(r.issue_id);
    out.set(r.dst_ref, arr);
  }
  return out;
}

export interface PlanItemBlockOverlay<T> {
  /** The items, with effectiveStatus flipped to 'blocked' where an open issue blocks. */
  items: T[];
  /** item id → open blocking issue ids, for UI annotation ('🚧 blocked by EI-NNN'). */
  blockingIssues: Record<string, string[]>;
}

/**
 * Overlay external engineer-issue blocks onto plan items that the PURE
 * @papercusp/plan-parser resolver has already resolved. `lookup(itemId)` returns
 * the OPEN blocking issue ids for an item (or undefined). An item with ≥1 open
 * blocker flips to effectiveStatus='blocked' UNLESS it's already terminal
 * (done/dropped — a shipped/abandoned item isn't "blocked"). Synchronous + pure
 * (the PG read is the caller's: getBlockingIssuesForPlan for one plan,
 * getAllBlockedPlanItems for many) so it's directly unit-testable and the resolver
 * stays I/O-free. Returns the (possibly mutated) items + the item→issue-ids map.
 */
export function applyPlanItemBlocks<T extends { id: string; effectiveStatus: string }>(
  items: T[],
  lookup: (itemId: string) => string[] | undefined,
): PlanItemBlockOverlay<T> {
  const blockingIssues: Record<string, string[]> = {};
  const overlaid = items.map((it) => {
    const issues = lookup(it.id);
    if (issues && issues.length > 0 && it.effectiveStatus !== 'done' && it.effectiveStatus !== 'dropped') {
      blockingIssues[it.id] = issues;
      return { ...it, effectiveStatus: 'blocked' } as T;
    }
    return it;
  });
  return { items: overlaid, blockingIssues };
}

/**
 * Single-plan convenience: read the plan's open issue-blocks + overlay them onto
 * `items` in one call. Non-fatal — on any PG error the items pass through
 * unchanged with an empty annotation map (so a coord_links/issues outage degrades
 * plans:get to resolver-only statuses rather than failing the read). Multi-plan
 * readers should instead hoist getAllBlockedPlanItems() out of their loop and call
 * applyPlanItemBlocks per plan.
 */
export async function overlayIssueBlocksForPlan<T extends { id: string; effectiveStatus: string }>(
  planSlug: string,
  items: T[],
): Promise<PlanItemBlockOverlay<T>> {
  try {
    const { blockedItems } = await getBlockingIssuesForPlan(planSlug);
    return applyPlanItemBlocks(items, (id) => blockedItems.get(id));
  } catch {
    return { items, blockingIssues: {} };
  }
}

/**
 * Every feature with ≥1 OPEN blocking issue → the blocking issue ids, keyed by the
 * harness-qualified featureRef ('<harness>#<feature_id>') (engineer-issues D-006 #2 —
 * the feature-side block edge is stored by issues:link {kind:'feature'} but was never
 * projected, so blocking a feature was a no-op). Returns the full map (engineer-issue
 * block edges are few) so a feature reader looks up the features it renders via
 * featureRef(harness, id) without an array bind. WIRED at harness:list_features (the
 * agent-facing feature reader → blockedByIssues annotation). The orchestrator-frontier
 * dispatch-gating (D-006 #3) stays deferred — it depends on the still-being-designed
 * assignment/claim/liveness model (project-centric-harness-rethink companion plans).
 */
export async function getBlockedFeatures(): Promise<Map<string, string[]>> {
  const { sql } = getOrgPg();
  const rows = await sql<{ blocked_ref: string; issue_id: string }[]>`
    SELECT d.blocked_ref, d.blocker_ref AS issue_id
      FROM harness_shared.work_item_deps d
      JOIN harness_shared.engineer_issues i
        ON i.issue_id = d.blocker_ref
     WHERE d.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND d.dep_type = 'blocks'
       AND d.blocker_kind = 'issue'
       AND d.blocked_kind = ${FEATURE_KIND}
       AND i.state = 'open'
     ORDER BY d.blocker_ref`;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const arr = out.get(r.blocked_ref) ?? [];
    arr.push(r.issue_id);
    out.set(r.blocked_ref, arr);
  }
  return out;
}
