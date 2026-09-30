import { z } from 'zod';
import { AGENT_ROLES, defineTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ToolResult } from '@papercusp/tooldef';
import { toolRequirementFor } from '../../recipe-contract';
import {
  savedRecipeAdapterFor,
  type SavedRecipeAdapter,
  type SavedRecipeAuthority,
} from './saved-recipe-adapter';

export const orchestrateSearchArgsSchema = z
  .object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(20).optional(),
    context: z
      .object({
        fleet: z.string().min(1).optional(),
        plan: z.string().min(1).optional(),
        harness: z.string().min(1).optional(),
        items: z.array(z.string().min(1)).max(100).optional(),
        resources: z.array(z.string().min(1)).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type OrchestrateSearchArgs = z.infer<typeof orchestrateSearchArgsSchema>;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function searchMatches(raw: unknown): Record<string, unknown>[] {
  const envelope = asRecord(raw);
  if (!envelope || envelope.ok !== true || !Array.isArray(envelope.recipes)) {
    throw new Error('orchestrate:search: recipes:search returned an invalid envelope');
  }
  return envelope.recipes.map((value) => {
    const recipe = asRecord(value);
    const runArgs = asRecord(recipe?.runArgs);
    const authority = asRecord(runArgs?.authority) as SavedRecipeAuthority | null;
    const revision = typeof authority?.revision === 'string' ? authority.revision : undefined;
    const capabilityManifest = asRecord(recipe?.capabilityManifest);
    const declared = Array.isArray(capabilityManifest?.requirements)
      ? capabilityManifest.requirements
      : undefined;
    const toolsUsed = Array.isArray(recipe?.toolsUsed)
      ? recipe.toolsUsed.filter((tool): tool is string => typeof tool === 'string')
      : [];
    const requirements = declared ?? toolsUsed.map((tool) => ({ capability: toolRequirementFor(tool) }));

    return {
      id: String(recipe?.id ?? ''),
      title: String(recipe?.title ?? ''),
      description: String(recipe?.description ?? ''),
      score: typeof recipe?.similarity === 'number' ? recipe.similarity : 0,
      toolsUsed,
      requirements,
      ...(recipe?.bindingSchema ? { bindings: recipe.bindingSchema } : {}),
      run: {
        recipe: {
          id: String(runArgs?.id ?? recipe?.id ?? ''),
          ...(revision ? { revision } : {}),
          ...(authority ? { authority } : {}),
        },
      },
    };
  });
}

export async function searchOrchestrations(
  args: OrchestrateSearchArgs,
  ctx: UnifiedToolContext,
  adapter: SavedRecipeAdapter = savedRecipeAdapterFor(ctx),
): Promise<ToolResult> {
  const raw = await adapter.search(args);
  const payload = { ok: true, query: args.query, matches: searchMatches(raw) };
  return { data: payload } as unknown as ToolResult;
}

const orchestrateSearchTool = defineTool({
  name: 'orchestrate:search',
  description:
    'Preferred read-only discovery for reusable orchestration. Delegates to the existing recipe search rail and returns exact runnable recipe continuations.',
  guidance: {
    when: 'Before authoring a new multi-step script; search for a reusable orchestration first.',
    notWhen: 'You already hold an exact recipe continuation and only need to inspect or run it.',
    chaining:
      'orchestrate:search { query } → orchestrate:inspect { recipe: match.run.recipe } → orchestrate:run { recipe: match.run.recipe }',
    seeAlso: ['orchestrate:inspect', 'orchestrate:run', 'recipes:search (compatibility door)'],
  },
  capability: 'recipes:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: orchestrateSearchArgsSchema,
  handler(args, ctx) {
    return searchOrchestrations(args, ctx);
  },
});

export default orchestrateSearchTool;
