/**
 * operator:standing_approvals_decide — approve or dismiss a standing-
 * approval candidate. Approve appends a [STANDING-APPROVE] entry to
 * the operator preferences.md; both decisions refresh the candidates
 * list so the pair drops out.
 *
 * Wraps the POST half of /api/agent-mcp/operator-standing-approvals.
 * Operator-role only — this writes to the operator preferences file
 * which downstream scans treat as authoritative.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { appendPreferenceEntry } from '../../operator-preferences';
import { refreshCandidates } from '../../operator-standing-candidates';

export default defineTool({
  name: 'operator:standing_approvals_decide',
  profile: 'engineer',
  description: 'Approve or dismiss a standing-approval candidate. Approve writes a [STANDING-APPROVE] entry to operator preferences.',
  capability: 'operator:write',
  guidance: {
    when: `User answered yes/no to a standing-approval prompt — record the decision so the autoaccept rule applies / doesn't.`,
    notWhen: `For ONE-OFF dispatch confirmation, just call \`panel_dispatch_card\` after the user yes/nos verbally. standing_approvals_decide is for the persistent rule.`,
    seeAlso: [
      'operator:standing_approvals_list (list pending approvals)',
      'harness:pending_reviews (one-off pending reviews)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.object({
    capability: z.string().min(1),
    targetHarness: z.string().min(1),
    decision: z.enum(['approve', 'dismiss']),
  }),
  async handler(args) {
    if (args.decision === 'approve') {
      const today = new Date().toISOString().slice(0, 10);
      const entry = `- [OPERATOR-PROPOSED-USER-CONFIRMED-${today}] [STANDING-APPROVE]\n  capability=${args.capability}, target=${args.targetHarness}\n  pattern: ≥3 silent dispatches in 24h\n  user confirmed: ${new Date().toISOString()}`;
      await appendPreferenceEntry(entry);
    }
    await refreshCandidates().catch(() => {});
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, decision: args.decision }) }],
    };
  },
});
