/**
 * POST /api/cupboard/publish-plugin — publish an installed distribution unit
 * (plugin OR runtime-less code-tool pack) TO the Cupboard as a `kind=plugin` /
 * `kind=pack` listing (revive-cupboard-distribution-2026-06-04 D-003 / P2;
 * pack kind: tool-distribution-granularity-2026-06-05 P-005).
 *
 * The publish logic lives in `cupboard/publish-plugin-core.ts`
 * (`publishInstalledUnitToCupboard`) — the ONE path shared with the
 * agent-callable `cupboard:publish-plugin` tool (cupboard-agent-tool-coverage-
 * 2026-07-14 P-001/P-004, D-001 reuse-first). This route only parses the loopback
 * request body and maps the structured result to an HTTP response.
 *
 * Body: { slug, github_url?, project_ref?, listing_ref?, title?, description?,
 *         provides_tools? }
 *
 * `auth: 'loopback'` (auth-tier Wave 1) — loopback-only via the operator's Host-header gate.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { publishInstalledUnitToCupboard } from '../../cupboard/publish-plugin-core';

export default defineTool({
  method: 'POST',
  path: '/cupboard/publish-plugin',
  auth: 'loopback',
  async handler(req) {
    let body: {
      slug?: string;
      github_url?: string;
      project_ref?: string;
      listing_ref?: string;
      title?: string;
      description?: string;
      provides_tools?: unknown;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    const result = await publishInstalledUnitToCupboard({
      slug: String(body.slug ?? ''),
      ...(typeof body.github_url === 'string' ? { github_url: body.github_url } : {}),
      ...(typeof body.project_ref === 'string' ? { project_ref: body.project_ref } : {}),
      ...(typeof body.listing_ref === 'string' ? { listing_ref: body.listing_ref } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(body.provides_tools != null ? { provides_tools: body.provides_tools } : {}),
    });

    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.error, detail: result.detail, upstream_status: result.upstream_status },
        { status: result.status },
      );
    }
    return Response.json({ ok: true, listing: result.listing });
  },
});
