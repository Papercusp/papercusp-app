/**
 * GET /api/flags/dashboard-url
 *
 * URL to the operator's PostHog dashboard. 404 when PostHog unconfigured.
 *
 * Ported from app/api/flags/dashboard-url/route.ts. `auth: 'public'`.
 */
import { getPosthogConfig } from '../../../posthog-config';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/flags/dashboard-url',
  auth: 'public',
  handler() {
    const config = getPosthogConfig();
    if (!config) {
      return Response.json({ ok: false, reason: 'unconfigured' }, { status: 404 });
    }
    const url = `${config.host.replace(/\/$/, '')}/project/@current/feature_flags`;
    return Response.json({ ok: true, url });
  },
});
