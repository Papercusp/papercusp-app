/**
 * recipes:merge — consolidate near-duplicate code:run RECIPES into one survivor
 * (the Queen's MERGE action from her recipe-graduation review,
 * code-recipes-2026-06-21 Phase 4, P-010 / D-015).
 *
 * The same @papercusp/search hybrid similarity that prevents duplicates at
 * write-time surfaces the near-duplicate CLUSTERS recipes:candidates returns;
 * after the Queen decides which to consolidate, this folds the duplicates INTO a
 * survivor: each duplicate flips to status='merged' with merged_into=<survivor>,
 * and its run_count/success_count are ADDED onto the survivor so the kept recipe
 * reflects the cluster's total usage. One transaction, idempotent, reversible
 * (a status/pointer flip). A recipe is never merged into itself; duplicate ids
 * outside the workspace are skipped.
 *
 * A REVIEW / curation action (not bee-authored) → SU_ROLES only. Read-only it is
 * NOT — it mutates the recipe corpus (intel:write).
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { mergeRecipes } from '../../code-recipes-store';

export default defineTool({
  name: 'recipes:merge',
  description:
    'Consolidate near-duplicate code:run RECIPES into one survivor: each duplicate flips to ' +
    'status=merged (pointing at the survivor) and its run_count/success_count are folded onto the ' +
    'survivor so it reflects the cluster\'s total usage. One transaction; never merges a recipe into ' +
    'itself; ids outside your workspace are skipped. Reversible (a status flip).',
  guidance: {
    when:
      'After reviewing a near-duplicate MERGE CLUSTER from recipes:candidates and deciding which one ' +
      'survives — pass the keeper as survivorId and the rest as duplicateIds to collapse the cluster ' +
      'into one recipe whose counts reflect all of them.',
    notWhen:
      'To retire a stale one-off (recipes:sweep) or to promote a recipe to a tool (file a work-item). ' +
      'Do not merge recipes that are genuinely distinct just because they look similar — the dedup ' +
      'score is a worklist, the merge decision is yours. Inspect each script with recipes:get first.',
    chaining:
      'recipes:candidates (mergeClusters) → recipes:get { id } per member to confirm they\'re truly ' +
      'duplicates → recipes:merge { survivorId, duplicateIds }.',
    seeAlso: [
      'recipes:candidates (the merge clusters this collapses)',
      'recipes:get (inspect each member before merging)',
      'recipes:sweep (retire a stale one-off instead of merging)',
    ],
  },
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    survivorId: z.string().min(1).describe('The recipe id (kebab slug) that survives — the duplicates fold INTO it.'),
    duplicateIds: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .describe('Recipe ids to merge into the survivor (status→merged, merged_into→survivor, counts added). The survivor id itself is ignored if present.'),
  }),
  async handler(args, ctx) {
    const { survivor, mergedIds } = await mergeRecipes(getOrgPg().sql, {
      survivorId: args.survivorId,
      duplicateIds: args.duplicateIds,
    });

    // Live-update the /admin/recipes dashboard (P-009): a merge flips duplicates to
    // status=merged + folds counts onto the survivor — both the list and the
    // candidate worklist change. Only when something actually merged. Best-effort.
    if (mergedIds.length > 0) {
      const { notifyRecipesChanged } = await import('../code/capture-recipe');
      await notifyRecipesChanged((msg) => ctx.log(msg));
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            survivor: {
              id: survivor.id,
              title: survivor.title,
              status: survivor.status,
              runCount: survivor.runCount,
              successCount: survivor.successCount,
            },
            mergedIds,
            mergedCount: mergedIds.length,
          }),
        },
      ],
    };
  },
});
