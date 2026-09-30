/**
 * plan-grinding.ts — which of a plan's live items are grinding right now.
 *
 * expensive-verification-loops-2026-09-29 P-002 (R-3). A plan item is GRINDING while a
 * work item linked to it has tripped the loop rule (loop-gate.ts) and no qualifying
 * `[attempt-audit]` note has cleared it — exactly the state in which the launch gate
 * would refuse its next slow attempt. Plan lifecycle (`plans:get`) shows the mark so a
 * reader sees the loop without opening every work item.
 *
 * A plan item links to a work item through `work_items.source_plan_item_ids` or
 * `payload.plan_item` (both are written today; older rows carry only the payload). The
 * candidate query already requires at least one slow task on the work item, so a plan
 * with no slow attempts costs one query and no per-item reads.
 *
 * Best-effort: any failure returns null ("not measured"), never an empty list.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { SLOW_ATTEMPT_MIN_MS } from './attempt-ledger';
import { checkLoopGate, type LoopGateDeps, type LoopTrigger } from './loop-gate';

/** Upper bound on linked work items evaluated per plan read. */
export const GRINDING_CANDIDATE_CAP = 25;

export interface GrindingMark {
  itemId: string;
  workItemId: string;
  triggers: LoopTrigger[];
  fingerprints: string[];
}

export interface LinkedWorkItem {
  workItemId: string;
  itemIds: string[];
}

export interface ReadGrindingDeps extends LoopGateDeps {
  listLinked?: (input: {
    workspaceId: string;
    planSlug: string;
    itemIds: readonly string[];
  }) => Promise<LinkedWorkItem[]>;
}

/**
 * The plan's work items (linked to `itemIds`) that have at least one slow attempt. Grinding
 * reads only live items; iteration metrics pass `includeTerminal` because a pass usually
 * closes the item.
 */
export async function listPlanLinkedWorkItems(
  input: { workspaceId: string; planSlug: string; itemIds: readonly string[] },
  sql: Sql,
  opts: { includeTerminal?: boolean } = {},
): Promise<LinkedWorkItem[]> {
  const ids = [...input.itemIds];
  const terminal = opts.includeTerminal ? [] : [...ANY_FAMILY_TERMINAL_STATES];
  const rows = await sql<{ feature_id: string; item_ids: string[] | null }[]>`
    SELECT w.feature_id,
           ARRAY(
             SELECT DISTINCT x FROM unnest(
               COALESCE(w.source_plan_item_ids, ARRAY[]::text[])
               || ARRAY[w.payload #>> '{plan_item,item_id}']
             ) AS x WHERE x IS NOT NULL
           ) AS item_ids
      FROM harness_shared.work_items w
     WHERE w.workspace_id = ${input.workspaceId}
       AND (w.source_plan_slug = ${input.planSlug}
            OR w.payload #>> '{plan_item,plan_slug}' = ${input.planSlug})
       AND (COALESCE(w.source_plan_item_ids, ARRAY[]::text[]) && ${ids}::text[]
            OR w.payload #>> '{plan_item,item_id}' = ANY(${ids}::text[]))
       AND NOT (w.status = ANY(${terminal}::text[]))
       AND w.lane IS DISTINCT FROM 'observation'
       AND EXISTS (
         SELECT 1 FROM harness_shared.task_ledger t
          WHERE t.workspace_id = w.workspace_id
            AND t.work_item_id = w.feature_id
            AND COALESCE(t.ended_at, now()) - t.started_at
                >= make_interval(secs => ${SLOW_ATTEMPT_MIN_MS / 1000})
       )
     ORDER BY w.feature_id
     LIMIT ${GRINDING_CANDIDATE_CAP}
  `;
  return rows.map((r) => ({ workItemId: r.feature_id, itemIds: (r.item_ids ?? []).filter((id) => ids.includes(id)) }));
}

/**
 * Annotate lifecycle live items with their grinding mark. Items without a mark are
 * returned unchanged; `marks` null/undefined (not measured) leaves every item unchanged.
 */
export function markGrindingItems<T extends { id: string }>(
  items: readonly T[],
  marks: readonly GrindingMark[] | null | undefined,
): Array<T | (T & { grinding: { workItemId: string; triggers: LoopTrigger[] } })> {
  if (!marks || marks.length === 0) return [...items];
  const byItem = new Map<string, GrindingMark>();
  for (const m of marks) if (!byItem.has(m.itemId)) byItem.set(m.itemId, m);
  return items.map((it) => {
    const m = byItem.get(it.id);
    return m ? { ...it, grinding: { workItemId: m.workItemId, triggers: m.triggers } } : it;
  });
}

/**
 * The grinding marks for the given plan items. Returns null when the read fails.
 * Only items in `itemIds` are considered; pass the plan's live, not-done items.
 */
export async function readGrindingItems(
  input: { workspaceId: string; planSlug: string; itemIds: readonly string[] },
  deps: ReadGrindingDeps = {},
): Promise<GrindingMark[] | null> {
  if (input.itemIds.length === 0) return [];
  try {
    const linked = deps.listLinked
      ? await deps.listLinked(input)
      : await listPlanLinkedWorkItems(input, deps.sql ?? (getOrgPg().sql as unknown as Sql));
    const marks: GrindingMark[] = [];
    for (const link of linked) {
      const decision = await checkLoopGate({ workspaceId: input.workspaceId, workItemId: link.workItemId }, deps);
      if (decision.allowed) continue;
      for (const itemId of link.itemIds) {
        marks.push({
          itemId,
          workItemId: link.workItemId,
          triggers: decision.verdict.triggers,
          fingerprints: decision.verdict.fingerprints,
        });
      }
    }
    return marks.sort((a, b) => a.itemId.localeCompare(b.itemId) || a.workItemId.localeCompare(b.workItemId));
  } catch {
    return null;
  }
}
