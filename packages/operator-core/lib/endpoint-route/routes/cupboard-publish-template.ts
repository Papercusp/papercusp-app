/**
 * POST /api/cupboard/publish-template — publish an app-template TO the Cupboard as
 * a `kind=template` listing (cupboard-full-dogfood-2026-07-10 P-003 / P-004).
 *
 * The publish logic lives in `cupboard/publish-template-core.ts`
 * (`publishTemplateToCupboard`) — the ONE path shared with the agent-callable
 * `cupboard:publish-template` tool (cupboard-agent-tool-coverage-2026-07-14 P-002,
 * D-001 reuse-first). This route only parses the loopback request body and maps
 * the structured result to an HTTP response.
 *
 * Body: { ref, github_url, listing_ref?, project_ref?, title?, description? }
 *
 * `auth: 'loopback'` (auth-tier Wave 1) — loopback-only via the operator's Host-header gate.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { publishTemplateToCupboard } from '../../cupboard/publish-template-core';

export default defineTool({
  method: 'POST',
  path: '/cupboard/publish-template',
  auth: 'loopback',
  async handler(req) {
    let body: {
      ref?: string;
      github_url?: string;
      listing_ref?: string;
      project_ref?: string;
      title?: string;
      description?: string;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    const result = await publishTemplateToCupboard({
      ref: String(body.ref ?? ''),
      github_url: typeof body.github_url === 'string' ? body.github_url : '',
      ...(typeof body.listing_ref === 'string' ? { listing_ref: body.listing_ref } : {}),
      ...(typeof body.project_ref === 'string' ? { project_ref: body.project_ref } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
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
