/**
 * GET /api/wiki-backlinks?target=<filename>[&harness=<slug>]
 * Ported from app/api/wiki-backlinks/route.ts. `auth: 'public'`.
 */
import { findWikiBacklinks } from '../../../wiki-backlinks';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/wiki-backlinks',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const target = (url.searchParams.get('target') ?? '').trim();
    const harness = url.searchParams.get('harness')?.trim() ?? null;
    if (!target) return Response.json({ error: 'missing target' }, { status: 400 });
    return Response.json(await findWikiBacklinks(target, harness));
  },
});
