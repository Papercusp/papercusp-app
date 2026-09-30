import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { setExternalTriggerBindingArmed } from '../../external-triggers/admin';
import { data, invalidateTriggers, triggerToolContext } from './_shared';

export default defineTool({
  name: 'triggers:disarm',
  profile: 'engineer',
  description: 'Disarm an external-event binding so new matching events cannot launch its plan.',
  guidance: {
    when: 'Pause an armed external binding while preserving its source, filter, storm policy, and history.',
    notWhen: 'To activate it use triggers:arm. This does not cancel a plan run that already launched.',
    chaining: 'triggers:status → triggers:disarm { bindingId, confirm:true } → triggers:status.',
    seeAlso: ['triggers:arm (resume the binding)', 'triggers:status (verify state)'],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({ bindingId: z.string().uuid(), confirm: z.literal(true) }),
  async handler(args, ctx) {
    const { sql, workspaceId } = triggerToolContext(ctx);
    const binding = await setExternalTriggerBindingArmed(sql, workspaceId, args.bindingId, false);
    if (!binding) return data({ ok: false, error: 'not_found', bindingId: args.bindingId });
    await invalidateTriggers(workspaceId);
    return data({ ok: true, binding });
  },
});
