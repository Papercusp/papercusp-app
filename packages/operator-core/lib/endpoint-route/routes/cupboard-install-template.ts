/**
 * POST /api/cupboard/install-template — install an app-template from the Cupboard
 * into the LOCAL template store (cupboard-full-dogfood-2026-07-10 P-003). The
 * template-store sibling of cupboard-install-plugin / cupboard-install-blueprint:
 * git-clone the listing's mirror repo, locate `<clone>/<listing_ref>/`, validate
 * it as a self-describing template dir, and drop it into the writable user
 * template layer so it shadows the bundled floor (resolve local→installed).
 * After install, `templates:new-app` materializes it via the same local path as a
 * bundled template — the standard-path install the templates surface was missing.
 *
 * Body: { listingId?, githubUrl?, listingRef? }
 *   - listingId  resolve the mirror repo URL + listing_ref from the Cupboard
 *                listing (kind-checked: a non-template listing is rejected 422)
 *   - githubUrl  OR install a mirror repo directly (listingRef = the template subdir)
 *
 * `auth: 'loopback'` (auth-tier Wave 1) — loopback-only via the operator's
 * Host-header gate, like the sibling cupboard routes. The Cupboard ships UNGATED.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { installTemplateFromCupboard } from '../../cupboard/install-template-io';

export default defineTool({
  method: 'POST',
  path: '/cupboard/install-template',
  auth: 'loopback',
  timeoutSec: 120,
  async handler(req) {
    let body: {
      listingId?: string;
      githubUrl?: string;
      listingRef?: string;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    // D-001 reuse-first: the SAME orchestrator the cupboard:install-template agent
    // tool calls (install-template-io.ts) — listing resolution + real-dep wiring +
    // structured result all live in one place. Map its result to the route's
    // pre-existing response shape (on success: the raw core result).
    const outcome = await installTemplateFromCupboard({
      ...(body.githubUrl ? { githubUrl: body.githubUrl } : {}),
      ...(body.listingRef ? { listingRef: body.listingRef } : {}),
      ...(body.listingId ? { listingId: body.listingId } : {}),
    });
    if (!outcome.ok) {
      return Response.json(
        { ok: false, error: outcome.error, ...(outcome.detail ? { detail: outcome.detail } : {}) },
        { status: outcome.status },
      );
    }
    return Response.json(outcome.result);
  },
});
