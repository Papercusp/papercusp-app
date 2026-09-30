/**
 * plan_items:my_items — the items assigned to me (my adopted agent-NAME AND/OR my
 * raw ownerId — EI-15910), with state.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { resolveAdoptedName } from '../../plan-items/agent-names';
import { resolveAgentIdentity } from '../coordination/identity';
import { myItemsWithStateForIdentities } from '../../plan-items/liveness';

export default defineTool({
  name: 'plan_items:my_items',
  description:
    'List the plan items assigned to you (across all plans), each with its live claim state (active / assigned-idle). "Go to your items" resolves here. Matches BOTH your adopted agent-NAME (if any) and your raw session identity (EI-15910/EI-2299 — a push assignment made by ownerId, e.g. coord:dispatch, targets that identity directly) — no adoption required to see items assigned straight to you. Adopting a name (plan_items:adopt_name) is only needed for a STABLE identity that survives across sessions, or to pass agent_name explicitly and act as someone else\'s name.',
  guidance: {
    when: 'You were told to work on your assigned items — read them here, then claim the next idle one.',
    notWhen: 'You want unassigned pool items — those are not "yours"; see plan_items:status for the pool.',
    chaining: 'plan_items:my_items → plan_items:claim { the next assigned-idle item }.',
    seeAlso: [
      'plan_items:adopt_name (adopt a stable name for cross-session assignment)',
      'plan_items:claim (claim the next assigned-idle item)',
      'plan_items:status (the whole group view)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent_name: z.string().max(80).optional().describe('act as this name ONLY (default: your adopted name, if any, PLUS your raw session identity)'),
    harness: z.string().max(120).optional().describe('workspace scope (default: papercup)'),
  }),
  async handler(args, ctx) {
    const { workspaceId } = await resolvePlanScope({ harnessSlug: args.harness });
    const explicit = args.agent_name?.trim();
    let identities: string[];
    let reportedName: string;
    if (explicit) {
      identities = [explicit];
      reportedName = explicit;
    } else {
      const identity = resolveAgentIdentity(ctx);
      const adopted = await resolveAdoptedName(workspaceId, identity.ownerId);
      identities = adopted ? [adopted, identity.ownerId] : [identity.ownerId];
      reportedName = adopted ?? identity.ownerId;
    }
    const items = await myItemsWithStateForIdentities(workspaceId, identities);
    return {
      data: { ok: true, agent_name: reportedName, matchedIdentities: identities, count: items.length, items },
    };
  },
});
