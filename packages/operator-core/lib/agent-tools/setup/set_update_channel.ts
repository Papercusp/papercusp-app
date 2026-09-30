import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { mergeSetupWizardState } from '../../endpoint-route/routes/desktop/setup-wizard-state';

/**
 * setup:set_update_channel — the conversational replacement for the wizard's
 * update-channel step (agent-first-onboarding-2026-07-03 P-004).
 */
export default defineTool({
  name: 'setup:set_update_channel',
  profile: 'engineer',
  description: "Choose the desktop app's release channel: alpha (freshest), beta, or stable.",
  capability: 'operator:write',
  guidance: {
    when: `Onboarding/tutorial: the user picked a channel (offer stable unless they want fresher builds). Verify with setup:status afterwards.`,
    seeAlso: ['setup:status (auto-update flips to ok once a channel is chosen)'],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger'],
  args: z.object({
    // Update LANES only — `nightly` is a side-by-side install (own bundle id,
    // own data home), never a lane an existing install can be switched to.
    channel: z.enum(['alpha', 'beta', 'stable']),
  }),
  async handler(args) {
    const next = await mergeSetupWizardState({ update_channel: args.channel });
    return { data: { update_channel: next.update_channel } };
  },
});
