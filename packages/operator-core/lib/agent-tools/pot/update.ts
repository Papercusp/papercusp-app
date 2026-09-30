/**
 * pot:update — edit a pot's config (hive-tool-namespace-2026-06-08 P-006).
 *
 * A thin writer over the home harness's registry entry: the deployment target
 * (where its execution plane runs) and per-instance config overrides (the
 * blueprint-knob residue — maxCostUsd, parallelWorkers, …). No agent-lifecycle
 * side effects (it never wakes/cancels). Does NOT change harness_kind — a pot
 * cannot reclassify (D-006). Root-only (a config change is an operator op).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { DeploymentConfigSchema } from '../../deployment/config-schema';
import { loadHarnessRegistry, saveHarnessRegistry } from '../../harness-registry';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { isPotProject, resolvePot } from './_resolve';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'pot:update',
  profile: 'engineer',
  description:
    "Edit a pot's config: its deployment target (execution plane) and per-instance config overrides (maxCostUsd, parallelWorkers, …). A thin registry writer — no agent-lifecycle effects (never wakes/cancels). Cannot change harness_kind (a pot cannot reclassify). Root-only.",
  guidance: {
    when: "Changing a pot's deployment target or its per-instance config overrides (budget/parallelism knobs).",
    notWhen:
      'Waking/pausing the Mug — pot:wake / pot:declare-wake. Placing/removing cups — fleet:*. Deploying to a cloud frame — deploy:pot.',
    chaining: 'pot:get { slug } to see the current config; deploy:pot to act on a changed deployment target.',
    seeAlso: [
      'pot:get (see the current config before updating)',
      'deploy:pot (act on a changed deployment target)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z.string().min(1).max(120).describe("The pot's home-harness slug."),
    deployment: DeploymentConfigSchema.optional().describe('New execution-plane target for the pot.'),
    configOverrides: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Per-instance blueprint-knob overrides to merge (maxCostUsd, parallelWorkers, …).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    if (actor.source === 'fleet-spawn') {
      return text({
        ok: false,
        error: 'hive_update_root_only',
        message: 'pot:update cannot be called from a cup (a spawned/parented agent). Only the operator/user edits a pot config.',
      });
    }
    if (args.deployment === undefined && args.configOverrides === undefined) {
      return text({ ok: false, error: 'nothing_to_update', message: 'Pass `deployment` and/or `configOverrides`.' });
    }

    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const reg = await loadHarnessRegistry(workspaceId);
    const idx = reg.projects.findIndex((p) => p.slug === args.slug && isPotProject(p));
    if (idx === -1) {
      return text({
        ok: false,
        error: 'hive_not_found',
        message: `No kind:'hive' harness '${args.slug}' in this workspace. Use pot:list to see the pots.`,
      });
    }

    const entry = { ...reg.projects[idx] };
    if (args.deployment !== undefined) entry.deployment = args.deployment;
    if (args.configOverrides !== undefined) {
      entry.configOverrides = { ...(entry.configOverrides ?? {}), ...args.configOverrides };
    }
    reg.projects[idx] = entry;
    await saveHarnessRegistry(reg, workspaceId);

    const pot = await resolvePot(args.slug, workspaceId);
    return text({ ok: true, slug: args.slug, pot });
  },
});
