import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { setExternalTriggerBindingArmed } from '../../external-triggers/admin';
import { data, invalidateTriggers, triggerToolContext } from './_shared';

export default defineTool({
  name: 'triggers:arm',
  profile: 'engineer',
  description: 'Arm an installed external-event binding so matching events may launch its plan.',
  guidance: {
    when: 'Activate a reviewed binding returned by triggers:bind. Pass confirm:true because this starts autonomous plan runs.',
    notWhen:
      'To install/edit the binding use triggers:bind. To pause it use triggers:disarm. For time triggers use plans:arm-schedule.',
    chaining: 'triggers:bind → triggers:arm { bindingId, confirm:true } → triggers:status.',
    seeAlso: ['triggers:disarm (pause the binding)', 'triggers:status (verify state)'],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({ bindingId: z.string().uuid(), confirm: z.literal(true) }),
  async handler(args, ctx) {
    const { sql, workspaceId } = triggerToolContext(ctx);
    const binding = await setExternalTriggerBindingArmed(sql, workspaceId, args.bindingId, true);
    if (!binding) return data({ ok: false, error: 'not_found', bindingId: args.bindingId });
    await invalidateTriggers(workspaceId);
    return data({ ok: true, binding });
  },
});
