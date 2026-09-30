/**
 * plan-status-read.ts — the ONE batched plan-status reader, P-013.
 *
 * WHY IT IS EXTRACTED. Two independent surfaces decide enforcement eligibility and both
 * need the same input: the work-item contract resolver (which namespaces may refuse a
 * completion) and the plan-ship coverage gate (may this plan's clauses refuse a ship).
 * This function was private to the resolver; the second caller's options were to import
 * the whole contract resolver for one query, or to write a second copy of it. A second
 * copy of a query that feeds a REFUSAL decision is the same defect class the enforced-set
 * duplication was: the two can disagree about which plans are exempt, and nothing fails.
 *
 * It deliberately does NOT live in `spec-enforcement-eligibility.ts`. That module's whole
 * design property is that it depends on nothing — pure classification, so any surface can
 * import it without a cycle. Putting a database read there would forfeit that.
 *
 * Deliberately narrow: only `status`, because that is all eligibility needs. The other
 * input — whether the plan adopted clauses — is already resolved by every caller (as
 * `group.clauses` at the resolver, as the census's clause total at the ship gate).
 */

/**
 * Read the status of each named plan. ONE query, never N.
 *
 * A plan that does not come back is simply ABSENT from the map. That is load-bearing and
 * must not be "fixed" by defaulting: callers read an absent slug as non-enforcing,
 * because `laneOf()` maps any unrecognized status to `enforceable`, so inventing a status
 * for a row we failed to read would QUIETLY enforce on a plan nobody could see. Absence
 * and "unknown status" are different facts and are kept different.
 */
export async function listPlanStatuses(input: {
  harnessSlug?: string;
  planSlugs: string[];
}): Promise<Map<string, string>> {
  if (input.planSlugs.length === 0) return new Map();
  const { resolvePlanScope } = await import('./source');
  const { withWorkspace } = await import('@papercusp/db-org');
  const scope = await resolvePlanScope({ harnessSlug: input.harnessSlug });

  const rows = await withWorkspace(
    scope.workspaceId,
    async (tx) => tx<{ plan_slug: string; status: string | null }[]>`
      SELECT p.plan_slug, p.status
        FROM harness_shared.harness_plans p
       WHERE p.workspace_id = ${scope.workspaceId}
         AND p.harness_slug = ${scope.harnessSlug}
         AND p.plan_slug = ANY(${input.planSlugs})
    `,
  );

  return new Map(rows.flatMap((row) => (row.status ? [[row.plan_slug, row.status] as const] : [])));
}

/** The shape every injectable copy of this reader must satisfy. */
export type PlanStatusReader = typeof listPlanStatuses;
