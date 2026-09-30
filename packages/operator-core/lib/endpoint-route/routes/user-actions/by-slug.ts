/**
 * GET /api/user-actions/:slug — long-running user actions for a harness.
 * Ported from app/api/user-actions/[slug]/route.ts. `auth: 'public'`.
 */
import { InvalidSlugError, listUserActions } from '../../../user-actions-data';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/user-actions/:slug',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get('limit') ?? '50') || 50;
    const since = Number(url.searchParams.get('since') ?? '0') || 0;
    try {
      const result = await listUserActions({ slug: ctx.params.slug, limit, since });
      return Response.json(
        { actions: result.actions },
        {
          headers:
            result.cacheStatus === 'HIT'
              ? { 'X-Cache': 'HIT', 'X-Cache-Age': String(result.cacheAgeMs) }
              : { 'X-Cache': result.cacheStatus },
        },
      );
    } catch (err) {
      if (err instanceof InvalidSlugError) {
        return Response.json({ error: 'invalid slug' }, { status: 400 });
      }
      throw err;
    }
  },
});
