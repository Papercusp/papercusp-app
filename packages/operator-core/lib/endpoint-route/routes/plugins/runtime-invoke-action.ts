/**
 * POST /api/plugins/runtime/invoke-action — diagnostic invoke of a
 * plugin action via the in-process registry. Different code path from
 * `/api/plugins/invoke` (which shells out to the `papercusp` CLI) —
 * useful for verifying Phase 6b wiring from the host.
 *
 * Body: { plugin: string; action: string; slug: string; params?: object }
 *
 * Relocated from app/api/_hono/plugins.ts (endpoint-hono-elimination
 * -2026-05-21 A3).
 */
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/plugins/runtime/invoke-action',
  auth: 'loopback',
  async handler(req) {
    const body = await req.json().catch(() => ({} as any));
    const plugin = String(body?.plugin ?? '');
    const action = String(body?.action ?? '');
    const slug = String(body?.slug ?? '');
    if (!plugin || !action || !slug) {
      return Response.json({ error: 'plugin, action, slug are all required' }, { status: 400 });
    }
    const { loadHarnessRegistry } = await import('../../../harness-registry');
    const project = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug) ?? null;
    const projectDir = project?.path ?? '/tmp';
    const stateDir = project ? `${project.path}/.papercusp` : '/tmp';
    const { invokePluginAction } = await import('../../../plugin-host-runtime');
    try {
      const r = await invokePluginAction({
        pluginName: plugin,
        actionName: action,
        installSlug: slug,
        projectDir,
        stateDir,
        params: body?.params,
        triggerSource: 'api',
        triggerId: `diag-${Date.now()}`,
      });
      return Response.json(r);
    } catch (e: any) {
      return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
    }
  },
});
