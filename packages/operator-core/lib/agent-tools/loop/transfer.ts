import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { transferLoopOwnership } from '../../harness/routines/loop';
import { activeWorkspaceId } from '../../workspace-registry';
import { refreshControlAnchorAfterMutation } from '../coordination/control-anchor';

export default defineTool({
  name: 'loop:transfer',
  profile: 'engineer',
  description:
    'Transfer one active engine loop to another session while preserving its cadence, fire history, limits, carry policy, cold carry-note (including declared deps), and parked state. Refuses when the destination already has an active loop.',
  guidance: {
    when: 'A loop objective should continue under a deliberate successor session instead of being ended and recreated.',
    notWhen: 'The original objective is finished — use loop:end. Moving work-item ownership without its loop — use work_items tools.',
    chaining: 'Use loop:status for both owners after transfer; the destination receives subsequent wakes and resumes from the transferred cold carry-note.',
    seeAlso: ['loop:status', 'loop:end'],
  },
  capability: 'routines:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    toOwnerId: z.string().min(1).max(120),
    fromOwnerId: z.string().min(1).max(120).optional().describe('Defaults to the caller.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const fromOwnerId = args.fromOwnerId ?? identity.ownerId;
    const result = await transferLoopOwnership(fromOwnerId, args.toOwnerId);
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    if (result.transferred) {
      await Promise.all([
        refreshControlAnchorAfterMutation({ ownerId: fromOwnerId, workspaceId, origin: 'agent', actorId: identity.ownerId, source: 'loop:transfer' }),
        refreshControlAnchorAfterMutation({ ownerId: args.toOwnerId, workspaceId, origin: 'agent', actorId: identity.ownerId, source: 'loop:transfer' }),
      ]);
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: result.transferred, fromOwnerId, toOwnerId: args.toOwnerId, ...result, advice: result.transferred ? 'Loop ownership transferred; verify the destination with loop:status.' : 'No active source loop was transferred, or the destination already owns an active loop.' }) }],
      isError: !result.transferred,
    };
  },
});
