/**
 * recipes:revise — audited, NON-EXECUTING source correction for one saved recipe.
 *
 * Historical recipe runs are immutable. This verb changes only the stored source
 * and derived tools_used metadata behind an exact-revision compare-and-swap; it
 * never invokes the script and never writes code_recipe_runs or popularity counts.
 */
import { z } from 'zod';
import { defineTool, listAllProjectedTools, SU_ROLES } from '@papercusp/agent-mcp';
import { ensureParseCheckReady } from '@papercusp/tooldef';
import { getOrgPg } from '@papercusp/db-org';
import { getRecipe, reviseRecipeSource } from '../../code-recipes-store';
import { recipeRevision } from '../../recipe-authority';
import { extractToolsUsed, notifyRecipesChanged } from '../code/capture-recipe';

const revisionSchema = z.string().regex(/^[0-9a-f]{64}$/);

export default defineTool({
  name: 'recipes:revise',
  description:
    'Revise the stored source of one saved recipe WITHOUT executing it. Requires the exact current ' +
    'revision plus a reason, compares-and-swaps the row, preserves its binding/capability contract ' +
    'and execution counters, refreshes toolsUsed, and returns old/new revisions. SU-only and audited ' +
    'through the normal tool invocation ledger.',
  guidance: {
    when:
      'Correcting a known defect in a saved recipe when its historical executions must remain immutable. ' +
      'First inspect with recipes:get, then pass that exact authority.revision as expectedRevision.',
    notWhen:
      'To run or replay a recipe (recipes:run), create one (code:run capture), change its runtime-input ' +
      'contract, or overwrite a revision you did not inspect. A stale expectedRevision fails closed.',
    chaining:
      'recipes:get { id } → recipes:revise { id, expectedRevision, script, reason } → recipes:get { id }; ' +
      'verify the revision changed and runCount/successCount did not.',
    seeAlso: [
      'recipes:get (inspect source, counters, and exact revision)',
      'recipes:run (execution/replay; deliberately not used by this verb)',
    ],
  },
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    id: z.string().min(1).describe('Saved recipe id / kebab slug.'),
    expectedRevision: revisionSchema.describe('Exact authority.revision returned by recipes:get.'),
    script: z
      .string()
      .min(1)
      .max(200_000)
      .describe('Complete replacement script source; it is stored, never executed.'),
    reason: z
      .string()
      .min(10)
      .max(1_000)
      .describe('Auditable reason for revising this immutable-run recipe definition.'),
  }),
  async handler(args, ctx) {
    const sql = getOrgPg().sql;
    const current = await getRecipe(sql, args.id);
    if (!current) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, id: args.id, error: 'not_found' }) }],
      };
    }

    const oldRevision = recipeRevision(current.script, current.updatedAt, current);
    if (oldRevision !== args.expectedRevision) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              id: args.id,
              error: 'stale_revision',
              expectedRevision: args.expectedRevision,
              currentRevision: oldRevision,
            }),
          },
        ],
      };
    }
    if (current.script === args.script) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ok: false, id: args.id, error: 'no_change', revision: oldRevision }) },
        ],
      };
    }

    await ensureParseCheckReady();
    const toolsUsed = extractToolsUsed(args.script, listAllProjectedTools());
    const revised = await reviseRecipeSource(sql, {
      id: args.id,
      script: args.script,
      toolsUsed,
      expectedUpdatedAt: current.updatedAt,
    });
    if (revised.status !== 'updated') {
      const currentRevision =
        revised.status === 'conflict'
          ? recipeRevision(revised.current.script, revised.current.updatedAt, revised.current)
          : null;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              id: args.id,
              error: revised.status === 'conflict' ? 'concurrent_revision' : 'not_found',
              currentRevision,
            }),
          },
        ],
      };
    }

    const row = revised.row;
    const newRevision = recipeRevision(row.script, row.updatedAt, row);
    await notifyRecipesChanged((message) => ctx.log(message));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            id: row.id,
            executed: false,
            reason: args.reason,
            oldRevision,
            newRevision,
            toolsUsed: row.toolsUsed,
            runCount: row.runCount,
            successCount: row.successCount,
          }),
        },
      ],
    };
  },
});
