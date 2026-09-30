/**
 * POST /api/plugins/runtime/fire-event — diagnostic event or lifecycle
 * fire through the host runtime. Useful for smoke-testing handler/rule
 * wiring without touching the substrate's mission lifecycle.
 *
 * Body: { event: string; lifecycle?: keyof PluginHooks; slug?: string;
 *         args?: unknown[]; payload?: unknown }
 *
 * `event` feeds the event-reaction matcher as a synthetic event (the
 * retired HookBus fire it used to do — plugin-system-hive-port P-006);
 * `lifecycle` fires the typed PluginHooks surface.
 *
 * Relocated from app/api/_hono/plugins.ts (endpoint-hono-elimination
 * -2026-05-21 A3).
 */
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/plugins/runtime/fire-event',
  auth: 'loopback',
  async handler(req) {
    const body = await req.json().catch(() => ({} as any));
    const event = typeof body?.event === 'string' ? body.event : '';
    const lifecycle = typeof body?.lifecycle === 'string' ? body.lifecycle : '';
    try {
      if (lifecycle) {
        const { firePluginLifecycle } = await import('../../../plugin-host-runtime');
        const slug = String(body?.slug ?? 'diag');
        const { loadHarnessRegistry } = await import('../../../harness-registry');
        const project = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug) ?? null;
        const ctxArgs = {
          installSlug: slug,
          projectDir: project?.path ?? '/tmp',
          stateDir: project ? `${project.path}/.papercusp` : '/tmp',
        };
        const args = Array.isArray(body?.args) ? body.args : [];
        await (firePluginLifecycle as any)(lifecycle, ctxArgs, ...args);
        return Response.json({ ok: true, fired: lifecycle, slug });
      }
      if (!event) {
        return Response.json({ error: 'event (string) or lifecycle (string) required' }, { status: 400 });
      }
      const { emitSystemEvent } = await import('../../../events/engine');
      const payload = body?.payload;
      emitSystemEvent({
        tool: event,
        args: (payload && typeof payload === 'object' ? payload : payload === undefined ? {} : { value: payload }) as Record<string, unknown>,
      });
      return Response.json({ ok: true });
    } catch (e: any) {
      return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
    }
  },
});
