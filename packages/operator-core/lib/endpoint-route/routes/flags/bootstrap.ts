/**
 * GET /api/flags/bootstrap
 *
 * Returns the resolved feature-flag payload for the calling user. Clients
 * (Tauri, browser, mobile) call this once at startup and again whenever the
 * /api/flags/stream SSE event tells them a flag changed.
 *
 * Ported from app/api/flags/bootstrap/route.ts. `auth: 'public'`.
 */
import { getAllFlags, isBackendConfigured } from '@papercusp/flags/server';

import { resolveDistinctId } from '../../../flag-distinct-id';
import { reinitFlagBackend } from '../../../flag-bus';
import { isTestingFeaturesEnabled } from '../../../posthog-config';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/flags/bootstrap',
  auth: 'public',
  async handler(req) {
    if (isBackendConfigured() !== isTestingFeaturesEnabled()) {
      reinitFlagBackend();
    }
    const distinctId = resolveDistinctId(req);
    const payload = await getAllFlags(distinctId);
    return new Response(JSON.stringify(payload), {
      headers: {
        'content-type': 'application/json',
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  },
});
