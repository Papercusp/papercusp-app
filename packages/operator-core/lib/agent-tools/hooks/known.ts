/**
 * hooks:known — return the static well-known hook-event allowlist.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getKnownHooks } from '../../known-hooks';

export default defineTool({
  name: 'hooks:known',
  profile: 'engineer',
  guidance: {
    when: 'Static enum of supported hook event names — use to validate an event string before firing or registering for it.',
    notWhen: 'For PENDING events queued up, use `pending_events:list`. For firing an event, use `plugins:fire_event`.',
  },
  description: 'Static well-known hook-event allowlist (kernel set; plugin-registered hooks extend this).',
  capability: 'roles:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({}),
  async handler() {
    return { data: { hooks: getKnownHooks() } };
  },
});
