import { z } from 'zod';

/**
 * P-017 slice D — the READ surface for the claim-time prior-attempt brief.
 *
 * Until this landed, the brief was computed at claim time and discarded: the only
 * way a human (or a compacted successor) could see "what was already tried on this
 * lane" was to CLAIM the item, which is a write with side effects. Slices A–C put
 * the brief and its raw drill-down behind `work_items:get`; this entry puts the same
 * port behind the operator UI.
 *
 * DELIBERATELY LAZY. The brief runs a multi-table collector under a 2.5s budget and
 * measured 869–3,499 estimated tokens on real items, so it must never ride a grid row
 * or a default detail render. The caller gates it with `useSyncQuery({ enabled })`,
 * so nothing is computed until a human opens the section.
 *
 * FAIL-SOFT, AND THE UI MUST SAY SO. `brief: null` means EITHER the item has no plan
 * pointer (nothing to compile) OR the collector timed out / errored — the compiler
 * returns null for both. It NEVER means "nothing was tried". `unavailableReason`
 * separates the two cases that ARE distinguishable here, so the panel can render an
 * honest empty state instead of an implied all-clear.
 */
export const workItemPriorAttemptsArgsSchema = z.object({
  // `.default('default')` matches every other workspace-scoped entry in this registry
  // (designFeatures.detail, designSketches.byFeature): the client omits it and the
  // single-tenant desktop build resolves to 'default'. Requiring it here would reject
  // every call the UI actually makes.
  workspaceId: z.string().default('default'),
  harnessSlug: z.string().min(1),
  workItemId: z.string().min(1),
  /**
   * Raw refs read off a brief's `omission.omittedRefs` (records the budget could only
   * count) or a clipped record's own `rawRef`. Resolving them returns the FULL
   * untruncated record. Independent of the brief itself: a caller often arrives holding
   * refs it read from a CLAIM reply rather than from this query.
   */
  rawRefs: z.array(z.string().min(1)).max(20).optional(),
});

export type WorkItemPriorAttemptsArgs = z.infer<typeof workItemPriorAttemptsArgsSchema>;

export async function resolveWorkItemPriorAttempts(
  args: WorkItemPriorAttemptsArgs,
): Promise<unknown[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const { workspaceId, harnessSlug, workItemId, rawRefs } = args;

  const rows = await sql`
    SELECT feature_id, harness_slug, payload, source_plan_slug, source_plan_item_ids
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND feature_id   = ${workItemId}
     LIMIT 1
  `;

  if (rows.length === 0) {
    // A missing row is a different fact from a missing brief. Say which.
    return [
      {
        workItemId,
        brief: null,
        refResolution: null,
        unavailableReason: 'work-item-not-found' as const,
      },
    ];
  }

  const r = rows[0] as {
    feature_id: string;
    harness_slug: string | null;
    payload: unknown;
    source_plan_slug: string | null;
    source_plan_item_ids: string[] | null;
  };

  const workItem = {
    id: r.feature_id,
    harness: r.harness_slug ?? harnessSlug,
    payload: r.payload,
    sourcePlanSlug: r.source_plan_slug,
    sourcePlanItemIds: r.source_plan_item_ids ?? undefined,
  };

  // ⚠ WI-2142613: THE `no-plan-pointer` REASON IS GONE, and with it the
  // `hasPlanPointer` computation that used to derive it.
  //
  // It existed to let the panel "distinguish 'no lane to report on' from 'the
  // collector failed'", which was a real and correct distinction while the collector
  // required a plan pointer. P-018 removed that requirement: an item with no plan now
  // compiles its OWN `self` rung — its checkpoint, its P-003 journal ring, its thread,
  // its lifecycle — so "no plan lane" no longer implies "no history to compile".
  //
  // Leaving the branch in place turned it into a lie in the one direction that costs
  // most. A null brief on an orphan means the COLLECTOR FAILED, but the panel rendered
  // "No plan lane on this item — there is no prior-attempt history to compile", i.e. a
  // failure disguised as an expected absence, for the 94.0% of open items carrying no
  // plan. The comment guarding that very branch reads "NEVER render this as 'nothing
  // was tried'" — which is precisely what it had come to do.
  //
  // Post-P-018 a null brief has exactly one meaning, so there is exactly one reason.
  const mod = await import('../prior-attempt-context');

  const brief = await mod
    .getClaimTimePriorAttemptBrief({ workItem, harness: workItem.harness })
    .catch(() => null);

  const refResolution = rawRefs?.length
    ? await mod
        .resolvePriorAttemptRefs({ workItem, harness: workItem.harness, rawRefs })
        .catch(() => null)
    : null;

  return [
    {
      workItemId,
      brief,
      refResolution,
      unavailableReason: brief ? null : ('collector-unavailable' as const),
    },
  ];
}
