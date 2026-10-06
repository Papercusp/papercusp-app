import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { exportTriggerPack, TriggerPackLifecycleError } from '../../cupboard/trigger-pack-lifecycle';
import { data, triggerToolContext } from '../triggers/_shared';

export default defineTool({
  name: 'trigger-packs:export',
  profile: 'engineer',
  description:
    'Write an installed trigger pack to an empty directory as a portable package: its manifest plus each plan sanitized back into a template. Installer mappings, inputs, ids and run history are never written.',
  guidance: {
    when: 'Sharing or republishing a pack you configured. The directory can then be published to the Cupboard.',
    notWhen: 'Exporting a single plan: cupboard:publish-plan.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    installationId: z.string().uuid(),
    outDir: z.string().min(1).max(1000).describe('Absolute path of an empty or missing directory.'),
  }),
  async handler(args, ctx) {
    const { sql, workspaceId } = triggerToolContext(ctx);
    try {
      return data({ ok: true, ...(await exportTriggerPack(sql, workspaceId, args)) });
    } catch (error) {
      if (!(error instanceof TriggerPackLifecycleError)) throw error;
      return data({ ok: false, error: error.code, detail: error.message, ...error.detail });
    }
  },
});
