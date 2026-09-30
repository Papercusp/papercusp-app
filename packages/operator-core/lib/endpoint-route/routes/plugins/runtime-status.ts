/**
 * GET /api/plugins/runtime/status — in-process plugin-host status report.
 *
 * `?reset=1` resets the plugin-host runtime + apiRoutes registry and
 * rebuilds the latter from disk. Used by install/uninstall flows that
 * symlink fresh plugins into ~/.papercusp/global-plugins/.
 *
 * Relocated from app/api/_hono/plugins.ts (endpoint-hono-elimination
 * -2026-05-21 A3).
 */
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/plugins/runtime/status',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const { pluginHostStatus, _resetPluginHostForTests } = await import('../../../plugin-host-runtime');
    if (url.searchParams.get('reset') === '1') {
      _resetPluginHostForTests();
      const { _resetPluginApiRoutesForTests, mountPluginApiRoutes } = await import('../../../plugin-api-mount');
      _resetPluginApiRoutesForTests();
      // Rebuild the in-memory apiRoutes registry so freshly-symlinked
      // plugins become reachable without a server restart.
      await mountPluginApiRoutes();
    }
    try {
      const s = await pluginHostStatus();
      return Response.json(s);
    } catch (e: any) {
      return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
    }
  },
});
