import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';
import { setDreamControl } from '../../dream/dream-control';
import { notifySyncInvalidate } from '../../sync-sse';

export default defineTool({
  name: 'dream:control',
  profile: 'engineer',
  description: 'Start/pause manual Dream cycles or explicitly enable/disable automatic Dream for one pot. Reuses its existing routines and owner setting; preserves the hard attempt/spend caps. Manual Start does not enable automatic dreaming.',
  capability: 'operator:write',
  requirePrincipal: false,
  // The controller owns its short, explicitly workspace-scoped transaction.
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  guidance: {
    when: 'The owner starts/pauses Dream or changes its separate automatic toggle in the Learning tab.',
    notWhen: 'For other learning lanes or budget changes use their existing controls.',
  },
  args: z.object({
    pot: z.string().trim().min(1).max(120),
    mode: z.enum(['manual', 'auto']),
    enabled: z.boolean(),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) throw new Error('Dream controls require operator configuration authority.');
    const { sql } = getOrgPg();
    await setDreamControl(sql, {
      workspaceId: activeWorkspaceId(), potSlug: args.pot, mode: args.mode, enabled: args.enabled,
      actor: resolveAgentIdentity(ctx).ownerId,
    });
    notifySyncInvalidate('learning.dream');
    notifySyncInvalidate('automation.catalog');
    notifySyncInvalidate('learning.loopControl');
    notifySyncInvalidate('hive.steering');
    return { data: { ok: true, ...args } };
  },
});
