/**
 * GET /api/desktop/telemetry-config — browser-side init endpoint for
 * posthog-js. Returns { enabled, host?, project_key? }.
 *
 * Gate: user opted in (telemetry_enabled === true) OR
 * PAPERCUSP_INTERNAL_BUILD === 'true'. Dev mode always returns disabled.
 *
 * Ported from app/api/desktop/telemetry-config/route.ts. `auth: {}`.
 */
import { readOperatorState } from '../../../operator-state-pg';
import { activeWorkspaceId } from '../../../workspace-registry';
import { ensureInstallId } from '../../../setup-wizard-install-id';
import { getPosthogConfigWithSource } from '../../../posthog-config';
import { POSTHOG_PUBLIC_DEFAULTS } from '../../../posthog-public-defaults';
import { defineTool } from '@papercusp/agent-mcp';

function resolveHostKey(): { host: string; projectKey: string } {
  const envHost = process.env.PAPERCUSP_POSTHOG_HOST;
  const envKey = process.env.PAPERCUSP_POSTHOG_KEY;
  if (envHost && envKey) return { host: envHost, projectKey: envKey };
  const phResolved = getPosthogConfigWithSource();
  if (phResolved.config) {
    return { host: phResolved.config.host, projectKey: phResolved.config.projectKey };
  }
  return { host: POSTHOG_PUBLIC_DEFAULTS.host, projectKey: POSTHOG_PUBLIC_DEFAULTS.projectKey };
}

export default defineTool({
  method: 'GET',
  path: '/desktop/telemetry-config',
  auth: {},
  async handler() {
    const installId = await ensureInstallId();
    const state = await readOperatorState<{ telemetry_enabled?: boolean }>('setup_wizard_state');

    const userOptedIn = Boolean(state?.telemetry_enabled);
    const internalBuild = process.env.PAPERCUSP_INTERNAL_BUILD === 'true';
    // Never ship dev clicks/sessions to production PostHog.
    if (process.env.NODE_ENV !== 'production') {
      return Response.json({ enabled: false, reason: 'dev-mode' });
    }
    const enabled = userOptedIn || internalBuild;
    if (!enabled) {
      return Response.json({ enabled: false, reason: 'user-opt-out' });
    }
    const { host, projectKey } = resolveHostKey();
    return Response.json({
      enabled: true,
      host,
      project_key: projectKey,
      distinct_id: installId,
      workspace_id: activeWorkspaceId(),
    });
  },
});
