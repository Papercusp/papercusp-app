/**
 * coord:handoffs — list handoff records (with acceptance status).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listHandoffs } from '../handoffs';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:handoffs',
  description:
    'List handoff records, each annotated with its acceptance/expiry sibling if one exists. Optional `status` filters to open (no acceptance, not auto-expired), accepted, or expired (auto-expired by the stale-handoff reconcile after sitting pending past the 12h TTL — F-FIX-037).',
  guidance: {
    when: 'Diagnostics — "who handed what to whom?", "what handoffs to me are still open?", or "which lapsed unaccepted?" (status: "expired").',
    notWhen: 'A single known msg_id — there is no read-by-id tool yet; the listing is small.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    status: z.enum(['open', 'accepted', 'expired']).optional(),
  }),
  async handler(args) {
    const out = await listHandoffs({ status: args.status });
    return { data: { handoffs: out } };
  },
});
