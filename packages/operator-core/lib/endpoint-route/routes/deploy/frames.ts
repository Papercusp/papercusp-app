/**
 * GET /api/deploy/frames → { frames: [{ slug, frame, desktop, region?, host? }] }
 *
 * The deployed-frame roster the Swarm live view (Frames tab) enumerates before
 * opening a per-slug `/api/deploy/:slug/frame-view` SSE stream
 * (`hive-frame-desktops-live-view-2026-06-06` P-006). Registry-backed: a frame
 * appears here exactly while its handle is persisted (deploy → teardown).
 *
 * `auth: 'loopback'` (auth-tier Wave 1) with NO session gate — the desktop webview is cookie-less
 * (loopback bind is the perimeter; see auth.ts header + auth/me). Same trust
 * class as the other workspace-global reads the /adv tabs hit
 * (`/harness/projects/lite`). A strict getSessionUser gate here 401s the
 * Frames tab in the shipping desktop.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';

export default defineTool({
  method: 'GET',
  path: '/deploy/frames',
  auth: 'loopback',
  async handler(req) {
    // Belt-and-braces (security review 2026-06-07): the cookie-less desktop
    // webview is why there is no session gate, but the loopback PERIMETER must
    // also be asserted in-handler — a listener-bind misconfiguration must not
    // silently de-authenticate the frame roster. Loopback callers (the desktop
    // webview, psu, agents) pass unchanged.
    const { loadHarnessRegistry } = await import('../../../harness-registry');
    const reg = await loadHarnessRegistry(activeWorkspaceId());
    const frames = reg.projects
      .filter((p) => p.deploymentFrame)
      .map((p) => ({
        slug: p.slug,
        frame: {
          id: p.deploymentFrame!.id,
          host: p.deploymentFrame!.host,
          region: p.deploymentFrame!.region,
          kind: p.deploymentFrame!.kind,
          target: p.deploymentFrame!.target,
        },
        desktop: p.deployment?.desktop ?? false,
      }));
    return Response.json({ frames });
  },
});
