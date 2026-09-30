/** scorecards:retract — withdraw one scorecard while preserving its evidence. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { retractScorecard } from '../../scorecards';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';

export const scorecardRetractArgs = z.object({
  issueId: z.string().min(1).max(120),
  reason: z.string().min(1).max(4000),
}).strict();

export default defineTool({
  name: 'scorecards:retract',
  profile: 'engineer',
  description:
    'Retract one rubric scorecard by issue id. Preserves the original evidence and adds machine-readable {at,by,reason} withdrawal metadata; default scorecard reads exclude it while audit reads can opt in.',
  guidance: {
    when: 'A scorecard is wholly invalid and must stop contributing to live list, trend, freshness, or gate reads.',
    notWhen: 'You have a corrected replacement — emit it with scorecards:emit { supersedes:<old issue id> } instead.',
    chaining: 'scorecards:retract { issueId, reason } → scorecards:list { rubricRef } to verify it disappeared; add includeRetracted:true for the audit view.',
    seeAlso: ['scorecards:emit', 'scorecards:list'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: scorecardRetractArgs,
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return { data: await retractScorecard(args.issueId, { by: identity.ownerId, reason: args.reason }) };
  },
});
