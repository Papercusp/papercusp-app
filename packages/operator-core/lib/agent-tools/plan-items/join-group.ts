/**
 * plan_items:join_group — opt into a shared plan's work-group (cross-user pull, D-005).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { bestEffortOwnerUser, resolveAdoptedName } from '../../plan-items/agent-names';
import { resolveAgentIdentity } from '../coordination/identity';
import { joinWorkGroup } from '../../plan-items/work-group';

export default defineTool({
  name: 'plan_items:join_group',
  description:
    'Join a shared plan\'s work-group so your sessions may CLAIM unassigned items from its pool (cross-user pull-only — nobody push-assigns onto your machine). A plan with no work-group is open; declaring one gates pool pulls to members.',
  guidance: {
    when: 'You want to help on a shared plan owned by another user — join, then pull unassigned items.',
    notWhen: 'It is your own plan / single-user — pool pulls are already open.',
    chaining: 'plan_items:join_group { harness, plan } → plan_items:status → plan_items:claim an unassigned item.',
    seeAlso: [
      'plan_items:status (see the group\'s items after joining)',
      'plan_items:claim (claim an unassigned item)',
      'plan_items:leave_group (leave the group)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    plan: z.string().min(1).describe('plan slug'),
    harness: z.string().max(120).optional().describe('harness the plan lives in (default: papercup)'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: args.harness });
    const memberName = await resolveAdoptedName(workspaceId, id.ownerId);
    const member = await joinWorkGroup(workspaceId, harnessSlug, args.plan, bestEffortOwnerUser(ctx), memberName);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, member }) }] };
  },
});
