import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveTriggerPackInstallationId, uninstallTriggerPack } from '../../cupboard/trigger-pack-lifecycle';
import { data, invalidateTriggers, triggerToolContext } from '../triggers/_shared';

export default defineTool({
  name: 'trigger-packs:uninstall',
  profile: 'engineer',
  description:
    'Uninstall a trigger pack from one harness: detach its bindings, archive its plans, revoke its grants there, and report workflows that still depend on it.',
  guidance: {
    when: 'Removing an installed trigger pack. Runs, work items, data sources and the plugin files are kept.',
    notWhen: 'Pausing it: triggers:disarm per binding.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    installationId: z.string().uuid().optional(),
    harness: z.string().min(1).max(120).optional(),
    plugin: z.string().min(1).max(240).optional(),
    confirm: z.literal(true),
  }),
  async handler(args, ctx) {
    const { sql, workspaceId } = triggerToolContext(ctx);
    const installationId = await resolveTriggerPackInstallationId(sql, workspaceId, {
      installationId: args.installationId,
      harnessSlug: args.harness,
      pluginName: args.plugin,
    });
    const result = installationId ? await uninstallTriggerPack(sql, workspaceId, installationId) : null;
    if (!result) return data({ ok: false, error: 'not_found' });
    await invalidateTriggers(workspaceId);
    return data({ ok: true, ...result });
  },
});
