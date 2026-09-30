/**
 * health:unack — remove a Health-tab panel acknowledgement early
 * (health-tab-v2-2026-07-12 P-004). The reverse of health:ack; acks also
 * auto-clear on recovery/snooze-expiry, so this is only for "re-alarm me now".
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { PANEL_ORDER } from '../../system-health/types';
import { clearHealthAck } from '../../system-health/acks';
import { runSystemHealthTick } from '../../system-health/compute';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'health:unack',
  description:
    'Remove a Health-tab panel acknowledgement (set by health:ack) so the panel counts toward the overall light again. Acks also auto-clear on recovery — this is the manual "re-alarm me now".',
  guidance: {
    when: 'An acked condition needs attention again before it recovers, or the ack reason no longer holds.',
    notWhen: 'The panel already recovered — the sweep cleared the ack automatically.',
    seeAlso: ['health:ack (set an ack)'],
  },
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    panel: z.enum(PANEL_ORDER as unknown as [string, ...string[]]).describe('The panel key to un-acknowledge.'),
  }),
  async handler(args) {
    const ws = activeWorkspaceId();
    const removed = await clearHealthAck(ws, args.panel);
    const health = removed ? await runSystemHealthTick(ws).catch(() => null) : null;
    return {
      data: {
        ok: true,
        panel: args.panel,
        removed,
        overall: health?.overall ?? null,
      },
    };
  },
});
