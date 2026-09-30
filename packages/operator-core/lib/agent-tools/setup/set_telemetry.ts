import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { mergeSetupWizardState } from '../../endpoint-route/routes/desktop/setup-wizard-state';

/**
 * setup:set_telemetry — records the user's telemetry CONSENT decision
 * (agent-first-onboarding-2026-07-03 P-004). Same validated merge-write the
 * wizard's PATCH /desktop/setup-wizard-state performs.
 */
export default defineTool({
  name: 'setup:set_telemetry',
  profile: 'engineer',
  description:
    'Record the telemetry consent decision (anonymized diagnostics + crash reports). Both true AND false count as "decided" — the setup step is satisfied either way.',
  capability: 'operator:write',
  guidance: {
    when: `Onboarding/tutorial: AFTER asking the user an explicit yes/no consent question. Never set it without asking — this is a consent record, not a default.`,
    notWhen: `Flushing or inspecting telemetry itself — that is the telemetry:* group.`,
    seeAlso: ['setup:status (telemetry flips to ok once decided)'],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger'],
  args: z.object({
    enabled: z.boolean().describe("The user's explicit consent answer"),
  }),
  async handler(args) {
    const next = await mergeSetupWizardState({ telemetry_enabled: args.enabled });
    return { data: { telemetry_enabled: next.telemetry_enabled } };
  },
});
