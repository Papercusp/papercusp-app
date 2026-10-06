/**
 * The production consumer read for `plan-item-consumer-view.ts` (WI-10005199).
 *
 * Mirrors EXACTLY what `plans:get-item` does to produce an item's `effectiveStatus`
 * (get-item.ts: `getPlanRow` → `planItemsForRow` → `resolveEffectiveStatusForItems`),
 * minus the workspace-wide issue-block overlay (`applyPlanItemBlocks`): that overlay is a
 * separate, derived signal over OTHER work, not a statement about whether this flip
 * landed in the index, and `getAllBlockedPlanItems` is a workspace-wide read that would
 * dominate the cost of a single-item attestation. A caller needing the overlay reads
 * `plans:get-item`; the attestation answers "did the plan index take the write".
 *
 * Separate from the leaf so `plan-item-consumer-view.ts` stays import-free of the PG
 * read graph (and so a test that partially mocks `./source` can stub just this module).
 */
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { getPlanRow, planItemsForRow } from './source';
import { resolveEffectiveStatusForItems } from './effective-status';
import type { ConsumedPlanItem, PlanItemConsumerReader } from './plan-item-consumer-view';

/**
 * Build the reader for one harness-scoped call context. `sctx` is the SAME scoped ctx the
 * write used, so the read resolves the same (workspace, harness) the write landed in.
 */
export function planItemConsumerReaderFor(sctx: unknown): PlanItemConsumerReader {
  return async (slug: string): Promise<readonly ConsumedPlanItem[] | null> => {
    const row = await getPlanRow(slug, await ctxToPlanSourceOpts(sctx));
    if (!row || row.isLegacy) return null;
    return resolveEffectiveStatusForItems(planItemsForRow(row)).items;
  };
}
