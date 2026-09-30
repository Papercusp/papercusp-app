/**
 * locks:cancel_wait — abandon a queued waiter ticket.
 *
 * Phase 1: stub. Waiter tickets are created by the wait subsystem in
 * Phase 2; with no wait path, there's nothing to cancel. The tool is
 * registered so the surface is stable across phases.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readFileLockIdentity } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryCancelWait } from './su-lock-store';
import { bulkContent, runBulk } from '../_bulk';

export default defineTool({
  name: 'locks:cancel_wait',
  description:
    'Abandon a queued waiter ticket. Returns cancelled=true if the wait was active; cancelled=false means a grant raced (you now hold a lock you didn\'t want — call locks:release immediately).',
  guidance: {
    when: 'Mid-wait, when the user redirects you to other work or you decide a different approach.',
    notWhen: 'After you\'ve already received an ok response from locks:acquire — there\'s no waiter to cancel.',
    chaining: 'On cancelled=false → locks:release { all_mine: true } to free the lock you got handed.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      ticket_id: z.string().uuid().optional().describe('single waiter ticket to cancel'),
      ticket_ids: z.array(z.string().uuid()).min(1).max(200).optional().describe('waiter tickets to cancel in one call'),
    })
    .refine((a) => Boolean(a.ticket_id) || (a.ticket_ids?.length ?? 0) > 0, {
      message: 'pass `ticket_id` or `ticket_ids`',
    }),
  async handler(args, ctx) {
    const { ownerId, coordinationDomain } = readFileLockIdentity(ctx);
    const ticketIds = Array.from(new Set([...(args.ticket_id ? [args.ticket_id] : []), ...(args.ticket_ids ?? [])]));
    const env = await runBulk(
      ticketIds,
      async (ticketId) => {
        const result = await inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
          tryCancelWait(tx, ticketId, ownerId),
        );
        return { ok: true as const, ticket_id: ticketId, cancelled: result.cancelled };
      },
      { keyOf: (ticketId) => ({ ticket_id: ticketId }) },
    );
    return bulkContent(env);
  },
});
