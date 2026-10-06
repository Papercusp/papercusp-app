import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  buildTriggerPackReview,
  listTriggerPackInstallations,
  resolveTriggerPackInstallationId,
} from '../../cupboard/trigger-pack-lifecycle';
import { data, triggerToolContext } from '../triggers/_shared';

export default defineTool({
  name: 'trigger-packs:review',
  profile: 'engineer',
  description:
    'List installed trigger packs, or read one pack\'s review: everything it can do once armed, plus the fingerprint trigger-packs:arm needs.',
  guidance: {
    when: 'Before arming an installed trigger pack, or to see which packs are installed, reviewed and armed.',
    notWhen: 'Hand-bound bindings: use triggers:status.',
    chaining: 'trigger-packs:review { installationId } → trigger-packs:arm { installationId, fingerprint, confirm:true }.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    installationId: z.string().uuid().optional(),
    harness: z.string().min(1).max(120).optional().describe('Harness slug; lists that harness, or names the pack with plugin.'),
    plugin: z.string().min(1).max(240).optional().describe('Plugin name, with harness, instead of installationId.'),
  }),
  async handler(args, ctx) {
    const { sql, workspaceId } = triggerToolContext(ctx);
    const installationId = await resolveTriggerPackInstallationId(sql, workspaceId, {
      installationId: args.installationId,
      harnessSlug: args.harness,
      pluginName: args.plugin,
    });
    if (!installationId) {
      if (args.installationId || args.plugin) return data({ ok: false, error: 'not_found' });
      return data({ ok: true, installations: await listTriggerPackInstallations(sql, workspaceId, { harnessSlug: args.harness }) });
    }
    const review = await buildTriggerPackReview(sql, workspaceId, installationId);
    if (!review) return data({ ok: false, error: 'not_found', installationId });
    return data({ ok: true, ...review });
  },
});
