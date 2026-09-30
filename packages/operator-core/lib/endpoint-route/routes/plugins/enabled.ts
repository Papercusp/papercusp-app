/**
 * GET /api/plugins/enabled — list per-harness enabled-plugin slugs (PG-canonical).
 * Ported from app/api/plugins/enabled/route.ts. `auth: 'public'`.
 */
import { listEnabledByHarness } from '../../../plugin-enables-pg';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/plugins/enabled',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const filterPlugin = url.searchParams.get('plugin');
    const enabled = await listEnabledByHarness();
    if (filterPlugin) {
      const byHarness: Record<string, boolean> = {};
      for (const [h, slugs] of Object.entries(enabled)) byHarness[h] = slugs.includes(filterPlugin);
      return Response.json({ plugin: filterPlugin, byHarness });
    }
    return Response.json({ enabled });
  },
});
