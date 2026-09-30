/**
 * recipes:get — fetch one OR many reusable code:run RECIPEs by id, including the
 * full script (code-recipes-2026-06-21 Phase 2, P-005; bulk-standardized per
 * bulk-endpoint-standardization-2026-06-21).
 *
 * The script is returned so an agent can INSPECT what the recipe does before
 * recipes:run-ning it (or adapt it into a new code:run). GLOBAL — recipes are a
 * fleet-wide capability (P-001). Read-only.
 *
 * Bulk by default (the house keyed-array contract): pass `id` for one or `ids`
 * for several → { ok, results:[{ ok, id, recipe? | error }], counts } — each
 * result self-describes its id, so a not-found id never poisons the rest and the
 * agent correlates by id (not array position).
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getRecipe } from '../../code-recipes-store';
import { mergeIds, runBulk, bulkContent } from '../_bulk';
import { deriveRecipeAuthority, recipeRevision, toRecipeAuthorityMetadata } from '../../recipe-authority';

export default defineTool({
  name: 'recipes:get',
  description:
    'Fetch one OR many reusable code:run RECIPEs by id — including the full script — so you can inspect ' +
    'what they do before recipes:run-ning them, including entity bindings and the current revision. Pass `id` for one or `ids` for several. Returns ' +
    '{ ok, results:[{ ok, id, recipe? | error }], counts } — correlate by id, not by position; a ' +
    'missing id comes back as that item\'s { ok:false } without failing the rest. Read-only. Recipes are ' +
    'global/fleet-wide; this tool accepts only `id`/`ids` and does not accept a `harness` argument.',
  guidance: {
    when:
      'When you have one or more recipe ids (from recipes:list / recipes:search / a code:run result\'s ' +
      'similarRecipes) and want to read their script + metadata before reusing. Recipes are global/fleet-wide; ' +
      'pass only `id` or `ids` (not `harness`).',
    notWhen:
      'To EXECUTE the recipe — use recipes:run (it runs the script under YOUR role-scoped envelope). ' +
      'To discover recipes by intent — recipes:search.',
    chaining:
      'recipes:search / recipes:list → recipes:get { ids:[…] } (inspect) → recipes:run { id } (reuse). ' +
      'Recipes are global, so omit `harness`; this tool accepts only `id`/`ids`. Bulk: single | ids[] → ' +
      '{ ok, results, counts }; correlate by id not position; one failure never fails the rest.',
    argRedirects: {
      harness: 'recipes:get is a global recipe read; omit `harness` and pass only `id` or `ids`.',
    },
    seeAlso: [
      'recipes:run (EXECUTE the recipe under your role-scoped envelope)',
      'recipes:search (discover recipes by intent)',
      'recipes:list (browse the recipe library)',
    ],
  },
  // Reading a reusable script is part of the same caller-scoped orchestration
  // flow as code:run. Its own execution still checks every nested tool.
  capability: 'agent_tools:read',
  requirePrincipal: false,
  // ALL ROLES (owner directive 2026-06-25) — in lockstep with code:run's audience.
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single recipe id / kebab slug (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('recipe ids to fetch (1–100)'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args) {
    const sql = getOrgPg().sql;
    const ids = mergeIds(args.id, args.ids);
    const env = await runBulk(
      ids,
      async (id) => {
        const recipe = await getRecipe(sql, id);
        if (!recipe) {
          return { ok: false as const, id, error: 'not_found' };
        }
        const authority = await deriveRecipeAuthority(recipe.script);
        const updatedAt = recipe.updatedAt ?? recipe.createdAt ?? '';
        return {
          ok: true as const,
          id,
          recipe: {
            id: recipe.id,
            title: recipe.title,
            description: recipe.description,
            script: recipe.script,
            bindingSchema: recipe.bindingSchema,
            capabilityManifest: recipe.capabilityManifest,
            toolsUsed: recipe.toolsUsed,
            authorRole: recipe.authorRole,
            runCount: recipe.runCount,
            successCount: recipe.successCount,
            lastRunAt: recipe.lastRunAt,
            status: recipe.status,
            tags: recipe.tags,
            // WI-40896 / D-048: one projection, in recipe-authority.ts, so the
            // rendering cannot silently drop a field the descriptor carries.
            // It adds `refsMeasured` + `unresolvedCause`, without which an
            // authority that could not be MEASURED is indistinguishable from a
            // recipe that genuinely needs none.
            authority: toRecipeAuthorityMetadata(
              authority,
              recipeRevision(recipe.script, updatedAt, recipe),
            ),
          },
        };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
