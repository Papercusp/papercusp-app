/**
 * harness:configure — WI-1563: set per-instance `configOverrides` on an
 * EXISTING, non-hive harness (the blueprint-knob residue — maxCostUsd,
 * parallelWorkers, … — that `instance-config.ts`'s `assembleInstanceConfig`
 * merges into the harness's assembled config / `HARNESS_CONFIG_JSON`
 * env-transport).
 *
 * A thin registry writer, mirroring `pot:update`'s configOverrides half
 * exactly (same merge semantics, same root-only guard) — but `pot:update` is
 * scoped to `harness_kind === 'hive'` projects only (D-006: a hive cannot
 * reclassify, and its tool never touches ordinary harnesses). Every OTHER
 * harness (coding / research / migration / generic-hive / …) had NO agent-tool
 * path to write `configOverrides` at all — only the one-time
 * `migrateConfigJsonToInstance` lift from a legacy `config.json`, or a direct
 * DB edit. This tool closes that gap for the non-hive case. Root-only (a
 * config change is an operator op, same rationale as pot:update); rejects a
 * hive slug (use `pot:update` there instead) so the two tools stay disjoint
 * rather than overlapping.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { loadHarnessRegistry, saveHarnessRegistry, type ProjectEntry } from '../../harness-registry';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { instanceEntryToConfig } from '../../deployment/instance-config';
import { POT_KIND } from '../pot/_resolve';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'harness:configure',
  profile: 'engineer',
  description:
    "Set per-instance config overrides (maxCostUsd, parallelWorkers, …) on an EXISTING non-hive harness — merges into the registry's configOverrides, the same knob residue pot:update writes for hives. Root-only. Rejects a hive slug (use pot:update there).",
  guidance: {
    when: 'Changing a non-pot harness\'s per-instance blueprint-knob overrides (budget/parallelism/etc) after it already exists.',
    notWhen:
      "Scaffolding a NEW harness — harness:create (which takes its own initial configOverrides). A hive's config — pot:update. Its typed instance fields (phase/dept) aren't touched here — those ride the same registry entry but via their own setters.",
    chaining: 'harness:overview or harness:health to see current state; harness:create for a brand-new harness.',
    seeAlso: [
      'pot:update (the equivalent tool, scoped to hive harnesses)',
      'harness:create (scaffold a new harness, with initial configOverrides)',
      'harness:overview (see current state)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z.string().min(1).max(120).describe('The existing harness slug to configure.'),
    configOverrides: z
      .record(z.string(), z.unknown())
      .describe('Per-instance blueprint-knob overrides to merge (maxCostUsd, parallelWorkers, …). Merged shallowly onto the existing overrides — pass a key with value null/undefined-shaped removal is NOT supported (set the key\'s new value directly).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    if (actor.source === 'fleet-spawn') {
      return text({
        ok: false,
        error: 'harness_configure_root_only',
        message: 'harness:configure cannot be called from a cup (a spawned/parented agent). Only the operator/user edits a harness config.',
      });
    }
    if (Object.keys(args.configOverrides).length === 0) {
      return text({ ok: false, error: 'nothing_to_update', message: 'Pass at least one key in `configOverrides`.' });
    }

    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const reg = await loadHarnessRegistry(workspaceId);
    const idx = reg.projects.findIndex((p) => p.slug === args.slug);
    if (idx === -1) {
      return text({
        ok: false,
        error: 'harness_not_found',
        message: `No harness '${args.slug}' in this workspace. Use harness:list to see the harnesses.`,
      });
    }
    if (reg.projects[idx].harness_kind === POT_KIND) {
      return text({
        ok: false,
        error: 'is_a_hive',
        message: `'${args.slug}' is a pot — use pot:update to change its configOverrides instead.`,
      });
    }

    const entry: ProjectEntry = { ...reg.projects[idx] };
    entry.configOverrides = { ...(entry.configOverrides ?? {}), ...args.configOverrides };
    reg.projects[idx] = entry;
    await saveHarnessRegistry(reg, workspaceId);

    return text({ ok: true, slug: args.slug, config: instanceEntryToConfig(entry) });
  },
});
