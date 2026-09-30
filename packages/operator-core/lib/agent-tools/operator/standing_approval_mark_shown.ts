/**
 * operator:standing_approval_mark_shown — set firstShownAt on a
 * standing candidate. Required for voice-approve eligibility per
 * voice-mode-plan-v4 §5d.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { markCandidateShown } from '../../operator-standing-candidates';

export default defineTool({
  name: 'operator:standing_approval_mark_shown',
  profile: 'engineer',
  description: 'Mark a standing-approval candidate as first-shown (timestamp gate for voice-approve eligibility).',
  capability: 'operator:write',
  guidance: {
    when: `Mark a standing-approval banner as shown so it doesn't re-flash. Internal UI bookkeeping.`,
    notWhen: `For listing approvals, use \`operator:standing_approvals_list\`. For deciding, \`operator:standing_approvals_decide\`.`,
    seeAlso: [
      'operator:standing_approvals_list (list approvals)',
      'operator:standing_approvals_decide (approve / deny)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect'],
  rolesQuota: { architect: { perRun: 50 }, operator: { perRun: 200 } },
  args: z.object({
    capability: z.string().min(1),
    targetHarness: z.string().min(1),
  }),
  async handler(args) {
    await markCandidateShown(args.capability, args.targetHarness);
    return { data: { ok: true, capability: args.capability, targetHarness: args.targetHarness } };
  },
});
