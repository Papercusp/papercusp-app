import { z } from 'zod';

/**
 * P-011 — the READ surface for a work item's resolved BehaviorContract.
 *
 * P-016 made applicability behavior-owned rather than plan-owned: a work item resolves
 * clauses across plan namespaces through explicit edges, with the source-plan stamp as
 * a back-compat leg (D-012/D-013). But the whole resolution was visible only to the
 * completion gate — a human could see WHETHER a completion was refused and never WHICH
 * promises the item is actually on the hook for, at WHICH revision.
 *
 * This runs the SAME `resolveWorkItemBehaviorContract` port the completion gate uses,
 * so the panel cannot drift from what the gate enforces.
 *
 * ⚠ WHAT THE UI MUST NOT DO WITH THIS (D-017, restated at the read surface because
 * this is where a renderer will reach for it): the resolver REPORTS, it never enforces.
 * `impact.report` is populated INDEPENDENTLY of any refusal, and `staleEdges` /
 * cross-namespace groups describe conditions nothing enforces yet — D-013 gives hard
 * enforcement to P-013. Rendering any of it as a FAILURE shows a human a blocking
 * error for a clause no gate is currently blocking on.
 *
 * WHY THE REVISION RIDES ON EVERY CLAUSE. A coverage claim without the revision it was
 * earned against is the exact thing this plan exists to end, so `specId` is never
 * surfaced here without its `revision` beside it, and `staleEdges` — an edge pinned to
 * a since-revised clause — is reported rather than silently dropped.
 *
 * DELIBERATELY LAZY, like workItems.priorAttempts: this is a multi-table resolution
 * (edges, then clauses per namespace), so the consumer gates it with
 * `useSyncQuery({ enabled })` and nothing runs until a human opens the section.
 */
export const workItemBehaviorContractArgsSchema = z.object({
  // `.default('default')` matches every other workspace-scoped entry in this registry;
  // the client omits it and the single-tenant desktop build resolves to 'default'.
  workspaceId: z.string().default('default'),
  harnessSlug: z.string().min(1),
  workItemId: z.string().min(1),
});

export type WorkItemBehaviorContractArgs = z.infer<typeof workItemBehaviorContractArgsSchema>;

/** One clause as the panel needs it: never a specId without the revision it holds. */
export interface BehaviorContractClauseView {
  specId: string;
  revision: number;
  planItemId: string;
  behavior: string;
  behaviorClass: string;
  lifecycleStatus: string;
  /** accepted | active — whether this clause carries an enforceable promise (D-012). */
  enforceable: boolean;
  /** D-016: null is an honest, gradeable gap — never synthesize one to fill it. */
  falsifier: { observation: string; probeMethod?: string } | null;
  mutationRequired: boolean;
}

export interface BehaviorContractGroupView {
  planSlug: string;
  via: 'edge' | 'plan-stamp' | 'edge+plan-stamp';
  clauses: BehaviorContractClauseView[];
  staleEdges: Array<{ specId: string; edgeRevision: number; currentRevision: number }>;
}

export interface WorkItemBehaviorContractRow {
  workItemId: string;
  groups: BehaviorContractGroupView[];
  enforceableCount: number;
  /** The item's OWN plan provenance, or null when standalone — a resolvable state now. */
  stampedPlanSlug: string | null;
  impact: {
    required: boolean;
    resolved: boolean;
    /** ADVISORY. Never render as a failure — see the module header. */
    report: string | null;
    reason: 'observation-lane' | 'non-behavior-changing' | 'resolved' | 'unresolved';
  } | null;
  unavailableReason: 'work-item-not-found' | 'resolver-unavailable' | null;
}

export async function resolveWorkItemBehaviorContract(
  args: WorkItemBehaviorContractArgs,
): Promise<unknown[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const { workspaceId, harnessSlug, workItemId } = args;

  const rows = await sql`
    SELECT feature_id, harness_slug, item_kind, payload, source_plan_slug, source_plan_item_ids
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND feature_id   = ${workItemId}
     LIMIT 1
  `;

  const empty = (unavailableReason: WorkItemBehaviorContractRow['unavailableReason']) => [
    {
      workItemId,
      groups: [],
      enforceableCount: 0,
      stampedPlanSlug: null,
      impact: null,
      unavailableReason,
    } satisfies WorkItemBehaviorContractRow,
  ];

  // A missing row is a different fact from an empty contract. Say which.
  if (rows.length === 0) return empty('work-item-not-found');

  const r = rows[0] as {
    feature_id: string;
    harness_slug: string | null;
    item_kind: string | null;
    payload: unknown;
    source_plan_slug: string | null;
    source_plan_item_ids: string[] | null;
  };

  const workItem = {
    id: r.feature_id,
    kind: r.item_kind,
    harness: r.harness_slug ?? harnessSlug,
    payload: r.payload,
    sourcePlanSlug: r.source_plan_slug,
    sourcePlanItemIds: r.source_plan_item_ids ?? undefined,
  };

  const mod = await import('../agent-tools/plans/behavior-contract-resolver');
  const contract = await mod.resolveWorkItemBehaviorContract(workItem).catch(() => null);
  // Fail-soft, and DISTINGUISHABLE: an empty contract ("this item is on the hook for
  // nothing") must never be rendered from a resolver that simply failed.
  if (!contract) return empty('resolver-unavailable');

  const stamp = mod.planStampOf(workItem);
  const enforceableLifecycle = new Set(mod.ENFORCEABLE_LIFECYCLE_STATUSES as readonly string[]);

  return [
    {
      workItemId,
      stampedPlanSlug: stamp?.planSlug ?? null,
      enforceableCount: contract.enforceable.length,
      impact: contract.impact,
      unavailableReason: null,
      groups: contract.groups.map((group) => ({
        planSlug: group.planSlug,
        via: group.via,
        staleEdges: group.staleEdges,
        clauses: group.clauses.map((clause) => ({
          specId: clause.specId,
          revision: clause.revision,
          planItemId: clause.planItemId,
          behavior: clause.behavior,
          behaviorClass: clause.behaviorClass,
          lifecycleStatus: clause.lifecycleStatus,
          enforceable: enforceableLifecycle.has(clause.lifecycleStatus),
          falsifier: clause.falsifier,
          mutationRequired: clause.mutationRequired,
        })),
      })),
    } satisfies WorkItemBehaviorContractRow,
  ];
}
