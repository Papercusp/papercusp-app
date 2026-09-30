/**
 * meta:define-tool — create a NEW tool, tier-routed (P-002, design D-003).
 *
 *   - composed             → registers LIVE as a code_recipe (a DAG over existing tools;
 *                            mints no new capability). Invoke it via recipes:run.
 *   - sandboxed-imperative → RUNTIME-DANGEROUS: NOT registered. Emits a reviewable
 *   | elevated               defineTool skeleton (P-004) for the PR rail — review +
 *                            adversarial confinement proof → platform:contribute.
 *
 * The routing decision is the pure `define-tool-router`; this handler executes it.
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { upsertRecipe } from '../../code-recipes-store';
import { resolveLearningPotSlug } from '../../learning/pot-scope';
import { activeWorkspaceId } from '../../workspace-registry';
import { routeDefineTool, type DefineToolSpec } from '../../define-tool-router';
import { TOOL_TIERS } from '../../tool-scaffold';

export default defineTool({
  name: 'meta:define-tool',
  description:
    'Create a NEW tool, routed by D-003 tier: composed (a DAG/recipe over EXISTING tools — mints no new ' +
    'capability, registers LIVE as a recipe you run via recipes:run) | sandboxed-imperative | elevated ' +
    '(genuinely new power — NOT registered; emits a reviewable skeleton for the PR rail + adversarial ' +
    'confinement proof → platform:contribute). Composed needs `script`; the dangerous tiers need group+verb+capability.',
  guidance: {
    when:
      'When a domain needs a new TOOL. Prefer composed (a recipe over existing primitives) — it is live and ' +
      'safe. Reach for sandboxed/elevated only for genuinely new power; those go through review, never runtime.',
    notWhen:
      'To define a DATATYPE (meta:define-datatype). To run an existing composition (recipes:run). To only ' +
      'GENERATE a skeleton without the tier routing (tools:scaffold).',
    chaining:
      'meta:define-tool { tier:"composed", script } → recipes:run. meta:define-tool { tier:"elevated", group, verb, capability } ' +
      '→ implement the emitted skeleton → PR + platform:contribute.',
    seeAlso: [
      'tools:scaffold (generate a skeleton without tier routing)',
      'recipes:run (run a composed-tier tool)',
      'tools:find (find an existing tool first)',
    ],
  },
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    name: z.string().min(1).max(120).describe('the tool name (e.g. "oddsmith:score-bet")'),
    description: z.string().min(1).max(2000).describe('one-line description'),
    tier: z
      .enum([...TOOL_TIERS] as [string, ...string[]])
      .describe('composed (recipe over existing tools, live) | sandboxed-imperative | elevated (review-gated)'),
    capability: z.string().min(1).max(120).optional().describe('required for sandboxed/elevated (the cap declared for review); ignored for composed'),
    script: z.string().min(1).max(20000).optional().describe('composed tier: the composition over existing tools (a recipes script)'),
    toolsUsed: z.array(z.string()).max(64).optional().describe('composed tier: the existing tool names the composition calls'),
    tags: z.array(z.string()).max(32).optional(),
    group: z.string().min(1).max(60).optional().describe('sandboxed/elevated: agent-tools group dir (kebab)'),
    verb: z.string().min(1).max(60).optional().describe('sandboxed/elevated: file/verb name (kebab)'),
    toolArgs: z
      .array(
        z.object({
          name: z.string().min(1).max(60),
          type: z.enum(['string', 'number', 'boolean', 'string[]']),
          required: z.boolean().optional(),
          description: z.string().max(400).optional(),
        }),
      )
      .max(32)
      .optional()
      .describe('sandboxed/elevated: the scaffolded tool\'s args'),
    firstClass: z.boolean().optional().describe('sandboxed/elevated: also emit a first-class migration stub'),
    migrationTable: z.string().min(1).max(80).optional(),
  }),
  async handler(args, ctx) {
    const reply = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });
    const spec: DefineToolSpec = {
      name: args.name,
      description: args.description,
      tier: args.tier as DefineToolSpec['tier'],
      capability: args.capability,
      script: args.script,
      toolsUsed: args.toolsUsed,
      tags: args.tags,
      group: args.group,
      verb: args.verb,
      args: args.toolArgs,
      firstClass: args.firstClass,
      migrationTable: args.migrationTable,
    };
    const route = routeDefineTool(spec);
    if (route.kind === 'error') {
      return reply({ ok: false, reason: 'invalid_spec', message: route.message });
    }
    if (route.kind === 'composition') {
      const ident = resolveAgentIdentity(ctx);
      const sql = getOrgPg().sql;
      // P-002 (pot-scope-all-learnings): a composed tool is a recipe — a learning —
      // so it carries the defining agent's pot.
      const potSlug = await resolveLearningPotSlug({
        workspaceId: ctx.workspaceId ?? activeWorkspaceId(),
        harnessSlug: ctx.harnessSlug ?? null,
      });
      const row = await upsertRecipe(sql, {
        id: route.recipe.id,
        title: route.recipe.title,
        description: route.recipe.description,
        script: route.recipe.script,
        toolsUsed: route.recipe.toolsUsed,
        tags: route.recipe.tags,
        createdBy: ident.ownerId,
        potSlug,
      });
      return reply({
        ok: true,
        tier: 'composed',
        tool: { name: spec.name, recipeId: row.id, invokeVia: 'recipes:run' },
        note: 'composed tool registered as a recipe (mints no new capability) — run it via recipes:run.',
      });
    }
    // scaffold (review-gated tiers)
    return reply({
      ok: true,
      tier: spec.tier,
      rail: route.result.rail,
      files: route.result.files,
      reviewNotes: route.result.reviewNotes,
      nextSteps: route.result.nextSteps,
      note: 'review-gated tier — skeleton emitted for the PR rail; do NOT enable at runtime (D-003).',
    });
  },
});
