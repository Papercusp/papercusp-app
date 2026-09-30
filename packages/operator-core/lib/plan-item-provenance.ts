/**
 * plan-item-provenance — which PLAN ITEMS was this work-item promoted from?
 *
 * The reverse direction of `plan-item-coverage.ts` (plan item → covering work-items),
 * kept as its own dependency-light module on purpose: the completion gate
 * (`harness-test-gate.ts`) asks this question on the write path and must not drag in
 * the coverage map's whole-workspace `coord_links` + fleet-assignment reads to do it.
 *
 * WHY THIS EXISTS (EI-19435123521651527, 2026-08-03). Three readers resolved this by
 * selecting `harness_features_consolidated.source_plan_item_ids` — a column the mint
 * path stopped writing. Measured in papercusp-workspace on the day of the fix:
 *
 *   source_plan_item_ids non-null ..............     1 row  (newest 2026-06-11)
 *   payload->'plan_item' present ............... 1,239 rows (newest that same day)
 *   source_plan_slug non-null .................. 1,229 rows (newest that same day)
 *
 * i.e. item-level provenance did not disappear, it MOVED: `plan-workitem-promotion-run.ts`
 * records a `PlanItemStamp` at `payload.plan_item` (plus a `coord_links` IMPLEMENTS edge)
 * and never passes `sourcePlanItemIds`. The readers stayed on the column and silently
 * resolved to "no plan provenance" — which for `itemTestGate` meant an early
 * `return { ok: true }`, so a completion gate that is supposed to refuse untested work
 * could not refuse anything. A gate that always passes and a gate with nothing to
 * complain about are indistinguishable from outside, which is why it stood for ~2 months
 * (and why it was graduated from the dark-flag set as "verified live with zero blast
 * radius").
 *
 * PRECEDENCE: the legacy column first (so the 1 row that has it, and any future
 * back-fill, still wins), then the stamp.
 *
 * NOT read here, deliberately: the `coord_links` work→plan_item edge. It is the more
 * normalized representation, but every row carrying item-level provenance today also
 * carries the stamp, so the edge would add a second query on a write path for zero
 * measured recall. If a stamp-less linked row ever appears, THAT is the fallback to add
 * — and `resolvePlanItemProvenance`'s `source` field is what makes it observable.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

interface ProvenanceRow {
  source_plan_slug: string | null;
  source_plan_item_ids: string[] | null;
  stamped_plan_slug: string | null;
  stamped_item_id: string | null;
}

export interface PlanItemProvenance {
  /** The plan this work-item came from, or null when it has no plan provenance. */
  planSlug: string | null;
  /** The plan items it was promoted from — empty when there is no item-level link. */
  itemIds: string[];
  /** Which representation answered — for diagnosis, and to spot a drift like this one. */
  source: 'column' | 'stamp' | 'none';
}

export const NO_PLAN_ITEM_PROVENANCE: PlanItemProvenance = {
  planSlug: null,
  itemIds: [],
  source: 'none',
};

/**
 * Resolve `workItemId`'s plan provenance. Throws on a PG failure — each caller owns its
 * own error posture (the completion gate FAILS OPEN, the prompt-context builder returns
 * null), so swallowing it here would take that choice away from them.
 */
export async function resolvePlanItemProvenance(
  harnessSlug: string,
  workItemId: string,
): Promise<PlanItemProvenance> {
  const { sql } = getOrgPg();
  const rows = await sql<ProvenanceRow[]>`
    SELECT source_plan_slug,
           source_plan_item_ids,
           payload -> 'plan_item' ->> 'plan_slug' AS stamped_plan_slug,
           payload -> 'plan_item' ->> 'item_id'   AS stamped_item_id
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${activeWorkspaceId()}
       AND harness_slug = ${harnessSlug}
       AND feature_id   = ${workItemId}
     LIMIT 1
  `;
  return planItemProvenanceFromRow(rows[0] ?? null);
}

/**
 * The pure precedence rule, split out so it can be tested without PG and reused by bulk
 * readers that select the same four fields for a whole plan in one query.
 */
export function planItemProvenanceFromRow(
  row: {
    source_plan_slug?: string | null;
    source_plan_item_ids?: string[] | null;
    stamped_plan_slug?: string | null;
    stamped_item_id?: string | null;
  } | null,
): PlanItemProvenance {
  if (!row) return NO_PLAN_ITEM_PROVENANCE;

  const planSlug = row.source_plan_slug ?? row.stamped_plan_slug ?? null;
  const columnIds = (row.source_plan_item_ids ?? []).filter((id) => typeof id === 'string' && id.length > 0);
  if (columnIds.length > 0) return { planSlug, itemIds: columnIds, source: 'column' };

  const stamped = row.stamped_item_id;
  if (stamped) return { planSlug, itemIds: [stamped], source: 'stamp' };

  return { planSlug, itemIds: [], source: 'none' };
}
