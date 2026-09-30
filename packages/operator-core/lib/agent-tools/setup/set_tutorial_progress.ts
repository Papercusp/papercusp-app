import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { mergeSetupWizardState } from '../../endpoint-route/routes/desktop/setup-wizard-state';

/**
 * setup:set_tutorial_progress — checkpoint the onboarding tutorial's position
 * (agent-first-onboarding-2026-07-03 P-013). Progress lives INSIDE
 * setup_wizard_state (validated merge, same write path as the wizard), and is
 * re-injected into the NEXT tutor session's launch context — which is what
 * makes the Papercusp Tutorial re-openable and resume-where-you-left-off.
 */
export default defineTool({
  name: 'setup:set_tutorial_progress',
  profile: 'engineer',
  description:
    'Checkpoint tutorial progress (last section id + completed section ids). The next tutor session reads it from its launch context to resume instead of restarting.',
  capability: 'operator:write',
  guidance: {
    when: `Onboarding tutor, at every chapter boundary and after each delivered section — checkpoint {last_section_id, completed_ids} so an interrupted tutorial resumes where it left off. Also when the user jumps chapters (record the new position).`,
    notWhen: `Recording SETUP steps (telemetry, channel, keys — those have their own setup:* verbs), or engineering work-item progress (work_items:checkpoint).`,
    seeAlso: [
      'setup:status (setup state; progress itself is delivered via the launch context)',
      'setup:complete (graduation — finishing setup, not tutorial position)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger'],
  args: z.object({
    last_section_id: z
      .string()
      .min(1)
      .optional()
      .describe('Pack section id the tutorial last delivered (e.g. ch2-01-plans)'),
    completed_ids: z
      .array(z.string().min(1))
      .optional()
      .describe('Full replacement list of completed section ids'),
    clear: z
      .boolean()
      .optional()
      .describe('true = erase all tutorial progress (restart from the top)'),
  }),
  async handler(args) {
    const next = await mergeSetupWizardState(
      args.clear
        ? { tutorial_progress: null }
        : {
            tutorial_progress: {
              ...(args.last_section_id ? { last_section_id: args.last_section_id } : {}),
              ...(args.completed_ids ? { completed_ids: args.completed_ids } : {}),
            },
          },
    );
    return {
      content: [
        { type: 'text', text: JSON.stringify({ tutorial_progress: next.tutorial_progress ?? null }) },
      ],
    };
  },
});
