/**
 * POST /api/cupboard/install-plugin — install a plugin from the Cupboard
 * (revive-cupboard-distribution-2026-06-04 D-003 / P2). Replaces the dead
 * `:3057`/CLI tarball install with a git clone of the listing's GitHub repo +
 * the existing capability-gate + install-consent path (D-009).
 *
 * The install logic lives in `cupboard/install-io.ts` (`installPluginFromCupboard`
 * — resolve coords → install core → backup trigger) — the ONE path shared with
 * the agent-callable `cupboard:install-plugin` tool (cupboard-agent-tool-coverage-
 * 2026-07-14 P-006, D-001 reuse-first). This route only parses the loopback body
 * and maps the structured result to an HTTP response.
 *
 * Body: { listingId?, githubUrl?, listingRef?, harness?, acceptCapabilities?, expectedReview? }
 *
 * A plugin that declares a data provider refuses with 409
 * `{ code:'provider_install_consent_required', data:{ review } }` until the
 * caller re-posts with `acceptCapabilities:true` and `expectedReview` set to
 * that `review` (generalized-integrations plan P-001 / D-006). Refusal `code`
 * and `data` are forwarded so the UI can render the review and re-call.
 *
 * `auth: 'loopback'` (auth-tier Wave 1) — loopback-only via the operator's Host-header gate. The
 * Cupboard ships UNGATED (no MARKETPLACE flag).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { installPluginFromCupboard } from '../../cupboard/install-io';
import type { InstallPluginManifestReview } from '../../cupboard/install-plugin-core';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export default defineTool({
  method: 'POST',
  path: '/cupboard/install-plugin',
  auth: 'loopback',
  timeoutSec: 120,
  async handler(req) {
    let body: {
      listingId?: string;
      githubUrl?: string;
      listingRef?: string;
      harness?: string;
      acceptCapabilities?: boolean;
      expectedReview?: unknown;
      triggerPackConfig?: { sourceMappings?: unknown; inputs?: unknown };
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    const outcome = await installPluginFromCupboard({
      ...(typeof body.listingId === 'string' ? { listingId: body.listingId } : {}),
      ...(typeof body.githubUrl === 'string' ? { githubUrl: body.githubUrl } : {}),
      ...(typeof body.listingRef === 'string' ? { listingRef: body.listingRef } : {}),
      ...(typeof body.harness === 'string' ? { harness: body.harness } : {}),
      acceptCapabilities: body.acceptCapabilities === true,
      ...(isPlainObject(body.expectedReview)
        ? { expectedReview: body.expectedReview as unknown as InstallPluginManifestReview }
        : {}),
      ...(isPlainObject(body.triggerPackConfig)
        ? {
            triggerPackConfig: {
              ...(isPlainObject(body.triggerPackConfig.sourceMappings)
                ? { sourceMappings: body.triggerPackConfig.sourceMappings as Record<string, string> }
                : {}),
              ...(isPlainObject(body.triggerPackConfig.inputs) ? { inputs: body.triggerPackConfig.inputs } : {}),
            },
          }
        : {}),
    });

    if (!outcome.ok) {
      return Response.json(
        {
          ok: false,
          error: outcome.error,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
          ...(outcome.code ? { code: outcome.code } : {}),
          ...(outcome.data ? { data: outcome.data } : {}),
        },
        { status: outcome.status },
      );
    }
    return Response.json(outcome.result);
  },
});
