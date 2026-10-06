import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { armTriggerPack } from '../../cupboard/trigger-pack-lifecycle';
import { data, invalidateTriggers, triggerToolContext } from '../triggers/_shared';

export default defineTool({
  name: 'trigger-packs:arm',
  profile: 'engineer',
  description:
    'Arm every binding of an installed trigger pack against the review fingerprint you read. A stale fingerprint is refused with the current review.',
  guidance: {
    when: 'Activate a configured trigger pack after reading trigger-packs:review. Pass confirm:true because this starts autonomous plan runs.',
    notWhen: 'Pausing one binding: triggers:disarm. A hand-bound binding: triggers:arm.',
    chaining: 'trigger-packs:review → trigger-packs:arm { installationId, fingerprint, confirm:true } → triggers:status.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    installationId: z.string().uuid(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    confirm: z.literal(true),
  }),
  async handler(args, ctx) {
    const { sql, workspaceId, actorId } = triggerToolContext(ctx);
    const result = await armTriggerPack(sql, workspaceId, {
      installationId: args.installationId,
      fingerprint: args.fingerprint,
      reviewedBy: actorId,
    });
    if (result.ok) await invalidateTriggers(workspaceId);
    return data(result);
  },
});
