/**
 * plan_items:leave_group — leave a plan's work-group.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { bestEffortOwnerUser } from '../../plan-items/agent-names';
import { leaveWorkGroup } from '../../plan-items/work-group';

export default defineTool({
  name: 'plan_items:leave_group',
  description: 'Leave a plan\'s work-group (stop being eligible to pull its unassigned items).',
  guidance: {
    when: 'You are done helping on a shared plan.',
    notWhen: 'You still hold claims there — release them first (plan_items:release).',
    chaining: 'plan_items:leave_group { harness, plan }.',
    seeAlso: [
      'plan_items:join_group (rejoin the group)',
      'plan_items:status (the group\'s current state)',
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
    const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: args.harness });
    const left = await leaveWorkGroup(workspaceId, harnessSlug, args.plan, bestEffortOwnerUser(ctx));
    return { data: { ok: true, left } };
  },
});
