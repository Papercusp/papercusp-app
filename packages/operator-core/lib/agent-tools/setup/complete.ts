import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { mergeSetupWizardState } from '../../endpoint-route/routes/desktop/setup-wizard-state';
import { collectSetupStatus } from '../../endpoint-route/routes/desktop/setup-status';
import { requiredOptionalSetupItems, statusStepForItemKey } from '../../onboarding/optional-setup-items';
import { readOperatorState } from '../../operator-state-pg';

/**
 * setup:complete — onboarding GRADUATION (agent-first-onboarding-2026-07-03
 * P-004/P-007): stamps `setup_wizard_state.finished_at`, after which the
 * first-run gateway routes to the normal app surface instead of onboarding.
 *
 * Idempotent: an existing finished_at is returned unchanged (a re-run of the
 * tutorial must not look like a fresh graduation); pass force to re-stamp.
 *
 * Required-item gate (desktop-update-center-and-release-tooling-2026-07-10 P-1):
 * graduation is REFUSED while any `required` optional-setup item is still
 * undecided (today just telemetry consent — a yes/no the user must answer, though
 * "no" satisfies it). The gate reuses collectSetupStatus (the SAME probe setup:status
 * projects), so the tutor cannot graduate a machine the wizard would still flag. `force`
 * overrides it (an operator escape hatch), mirroring the finished_at re-stamp override.
 */
export default defineTool({
  name: 'setup:complete',
  profile: 'engineer',
  description:
    'Mark onboarding finished (writes setup_wizard_state.finished_at). The app then boots to its normal surface. Idempotent unless force.',
  capability: 'operator:write',
  guidance: {
    when: `ONLY at the end of the onboarding tutorial (graduation), after the required setup steps verify ok via setup:status. Tell the user what it means: the app now opens normally; the tutorial stays available via the Papercusp Tutorial icon.`,
    notWhen: `Mid-tutorial, or to "skip" onboarding on the user's behalf without asking — graduation is the user's moment, not a shortcut.`,
    seeAlso: ['setup:status (verify required steps before graduating)'],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger'],
  args: z.object({
    force: z.boolean().optional().describe('Re-stamp finished_at even if already set'),
  }),
  async handler(args) {
    const current = await readOperatorState<{ finished_at?: string }>('setup_wizard_state');
    if (current?.finished_at && !args.force) {
      return {
        data: { finished_at: current.finished_at, alreadyFinished: true },
      };
    }

    // Required-item gate: refuse graduation while any `required` optional-setup
    // item is undecided. `force` bypasses (operator escape hatch).
    if (!args.force) {
      const required = requiredOptionalSetupItems();
      if (required.length) {
        const { statuses } = await collectSetupStatus();
        const undecided = required.filter((item) => {
          const step = statusStepForItemKey(item.key);
          // Only gate on items we can actually probe; an unmapped required item
          // must not silently block graduation forever.
          return step in statuses && statuses[step as keyof typeof statuses] !== 'ok';
        });
        if (undecided.length) {
          return {
            data: {
              error: 'required_setup_undecided',
              alreadyFinished: false,
              undecided: undecided.map((i) => i.key),
              message: `Cannot graduate: ${undecided
                .map((i) => i.label)
                .join(', ')} still needs an explicit decision. Ask the user (a "no" is a valid answer), record it via the matching setup:* verb, then retry. Pass force:true only to override.`,
            },
          };
        }
      }
    }

    const next = await mergeSetupWizardState({ finished_at: new Date().toISOString() });
    return {
      data: { finished_at: next.finished_at, alreadyFinished: false },
    };
  },
});
