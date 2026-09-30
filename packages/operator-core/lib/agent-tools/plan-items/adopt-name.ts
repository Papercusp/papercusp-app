/**
 * plan_items:adopt_name — adopt a stable agent-NAME for this session (D-006).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { adoptAgentName, bestEffortOwnerUser } from '../../plan-items/agent-names';

export default defineTool({
  name: 'plan_items:adopt_name',
  description:
    'Adopt a stable agent-NAME for this session (e.g. "builder-1"). Assignment targets a NAME, not a session, so after adopting you can read your assigned items (plan_items:my_items) and claim them across interruptions. Idempotent; re-adopting overwrites this session\'s name.',
  guidance: {
    when: 'At the start of a session that should act as a named agent — e.g. you were told "you are builder-1, go to your items". Adopt the name, then plan_items:my_items.',
    notWhen: 'Ad-hoc one-off work you are not coordinating by name — you can still claim unassigned pool items without a name.',
    chaining: 'plan_items:adopt_name { name } → plan_items:my_items → plan_items:claim.',
    seeAlso: [
      'plan_items:my_items (items assigned to your adopted name)',
      'plan_items:claim (claim an assigned-idle item)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    name: z.string().min(1).max(80).describe('the stable agent-name to act as (e.g. "builder-1")'),
    harness: z.string().max(120).optional().describe('harness whose workspace the name lives in (default: papercup)'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const { workspaceId } = await resolvePlanScope({ harnessSlug: args.harness });
    const ownerUser = bestEffortOwnerUser(ctx);
    const binding = await adoptAgentName(workspaceId, id.ownerId, args.name, ownerUser);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, adopted: binding }) }],
    };
  },
});
