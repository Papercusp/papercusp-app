/**
 * POST /api/cupboard/install-app — install a BUNDLE app from the Cupboard
 * (cupboard-app-distribution-2026-07-14 P-008). A STANDALONE app has no install
 * action here — it is a download-link handoff owned by the detail page's
 * AppDownloadPanel (P-005), not this route.
 *
 * The install logic (manifest fetch/parse + the datatype/pack/plugin/blueprint
 * dep-composition) lives in `cupboard/bundle-app-install-io.ts`
 * (`installBundleAppFromCupboard`) — the ONE path shared with the
 * agent-callable `cupboard:install-app` tool (D-001 reuse-first). This route
 * only parses the loopback body and maps the structured result to an HTTP
 * response.
 *
 * Body: { listingId?, githubUrl?, listingRef?, allowConflicts? }
 *
 * `auth: 'loopback'` (auth-tier Wave 1) — loopback-only via the operator's Host-header gate.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { installBundleAppFromCupboard } from '../../cupboard/bundle-app-install-io';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  method: 'POST',
  path: '/cupboard/install-app',
  auth: 'loopback',
  timeoutSec: 180,
  async handler(req) {
    let body: {
      listingId?: string;
      githubUrl?: string;
      listingRef?: string;
      allowConflicts?: boolean;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    const outcome = await installBundleAppFromCupboard(
      {
        ...(typeof body.listingId === 'string' ? { listingId: body.listingId } : {}),
        ...(typeof body.githubUrl === 'string' ? { githubUrl: body.githubUrl } : {}),
        ...(typeof body.listingRef === 'string' ? { listingRef: body.listingRef } : {}),
        allowConflicts: body.allowConflicts === true,
      },
      { workspaceId: activeWorkspaceId() },
    );

    if (!outcome.ok) {
      return Response.json(
        { ok: false, error: outcome.error, ...(outcome.detail ? { detail: outcome.detail } : {}) },
        { status: outcome.status },
      );
    }
    return Response.json({ manifest: outcome.manifest, ...outcome.result });
  },
});
