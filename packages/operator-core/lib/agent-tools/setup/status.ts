import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { collectSetupStatus } from '../../endpoint-route/routes/desktop/setup-status';

/**
 * setup:status — the tutor's verification read
 * (agent-first-onboarding-2026-07-03 P-004). Projects the SAME
 * `collectSetupStatus()` the GUI wizard's sidebar uses, so the tutorial and
 * the wizard can never disagree about what is configured.
 */
export default defineTool({
  name: 'setup:status',
  profile: 'engineer',
  description:
    'Auto-detected setup state: every Setup-Wizard step status (ok / needs-attention / unknown) plus the per-runtime agent breakdown (claude / codex / omp) and modelEgress (WI-3186: whether the inference gateway is currently wholesale rate-limited — a signed-in CLI can still fail every model call). Same detection read the GUI wizard uses.',
  capability: 'operator:read',
  guidance: {
    when: `Onboarding/tutorial flows: read BEFORE offering a setup step (skip what is already ok) and RE-READ after acting — never tell the user a step is configured without this re-read.`,
    notWhen: `Per-provider sign-in token detail (expiry, refresh) — that lives on the /desktop/agent-auth-status route, not here.`,
    seeAlso: [
      'setup:complete (graduation — writes finished_at)',
      'setup:set_git_identity / setup:set_telemetry / setup:set_update_channel / setup:save_key (the write verbs this verifies)',
      'backup:settings_set (backups are configured via the existing backup group, not a setup:* verb)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger'],
  args: z.object({}),
  async handler() {
    return {
      content: [{ type: 'text', text: JSON.stringify(await collectSetupStatus()) }],
    };
  },
});
