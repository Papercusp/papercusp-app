/**
 * recipes:list — the agent-facing read of reusable code:run RECIPES
 * (code-recipes-2026-06-21 Phase 2, P-005).
 *
 * A recipe is a saved code:run script (captured on every successful run, D-012);
 * recipes are GLOBAL — a fleet-wide capability (P-001, reversing D-005). This lists
 * the active recipes most-run first (the hot recipes surface), so an agent can
 * browse what's reusable before authoring a fresh code:run. Read-only.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { listRecipes } from '../../code-recipes-store';

export default defineTool({
  name: 'recipes:list',
  description:
    'List reusable code:run RECIPES for your hive (most-run first). A recipe is a saved code:run ' +
    'script other agents authored; browse them to reuse instead of re-authoring. Low-value ' +
    '(≤1-tool / auto-titled) recipes are hidden by default — pass includeTrivial to see all. Read-only.',
  guidance: {
    when:
      'Before authoring a multi-step code:run, to see what reusable recipes already exist in your ' +
      'hive — the hot ones surface first. If one fits, recipes:run it instead of re-writing the script.',
    notWhen:
      'When you already know the recipe id (recipes:get), or to find a recipe by intent (recipes:search ' +
      'ranks by semantic + tool-set similarity). This is the plain most-run-first browse.',
    chaining:
      'recipes:list → recipes:get { id } to inspect the script → recipes:run { id } to reuse it.',
    seeAlso: [
      'recipes:search (find a recipe by intent instead of browsing)',
      'recipes:get (inspect a recipe\'s script)',
      'recipes:run (reuse a recipe instead of re-authoring a code:run)',
    ],
  },
  capability: 'agent_tools:read',
  requirePrincipal: false,
  // ALL ROLES (owner directive 2026-06-25) — in lockstep with code:run's audience.
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    limit: z.number().int().min(1).max(100).optional().describe('Max recipes to return (default 25).'),
    includeTrivial: z
      .boolean()
      .optional()
      .describe(
        'Include low-value recipes (≤1-tool wrappers + auto-derived-title throwaways) hidden by ' +
          'default. Default false — the browse shows reuse-worthy multi-tool recipes only.',
      ),
  }),
  async handler(args) {
    const limit = args.limit ?? 25;
    const all = await listRecipes(getOrgPg().sql, { limit, includeTrivial: args.includeTrivial ?? false });
    const recipes = all.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      toolsUsed: r.toolsUsed,
      runCount: r.runCount,
      successCount: r.successCount,
      lastRunAt: r.lastRunAt,
      status: r.status,
    }));
    return {
      data: { ok: true, count: recipes.length, recipes },
    };
  },
});
