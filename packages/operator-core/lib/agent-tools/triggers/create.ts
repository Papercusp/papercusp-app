import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { createExternalTriggerSource } from '../../external-triggers/admin';
import { data, invalidateTriggers, triggerToolContext } from './_shared';

export default defineTool({
  name: 'triggers:create',
  profile: 'engineer',
  description:
    'Create a workspace external-trigger source definition with non-secret config and an optional opaque credential reference.',
  guidance: {
    when: 'Install a Slack, Gmail, Calendar, or other external source before attaching it to a plan.',
    notWhen:
      'Never pass raw tokens, passwords, or client secrets in config; store them outside the repo and pass only credentialRef. To attach an existing source use triggers:bind.',
    chaining: 'triggers:create → provider connect flow stores the credential → triggers:bind → triggers:arm.',
    seeAlso: ['triggers:bind (attach source events to a plan)', 'triggers:list (discover existing sources)'],
  },
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    kind: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .max(80),
    config: z.record(z.string(), z.unknown()).optional().describe('NON-SECRET provider config only'),
    credentialRef: z
      .string()
      .min(1)
      .max(500)
      .nullable()
      .optional()
      .describe('opaque reference; never raw secret material'),
    status: z.enum(['unconfigured', 'ready', 'connecting', 'connected', 'degraded', 'error', 'disabled']).optional(),
  }),
  async handler(args, ctx) {
    const { sql, workspaceId, actorId } = triggerToolContext(ctx);
    const source = await createExternalTriggerSource(sql, workspaceId, { ...args, createdBy: actorId });
    await invalidateTriggers(workspaceId);
    return data({ ok: true, source });
  },
});
