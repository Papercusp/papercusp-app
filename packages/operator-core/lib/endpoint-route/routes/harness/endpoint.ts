/**
 * POST /api/harness/:slug/endpoint — a harness sidecar advertises its local HTTP
 * endpoint to the operator (`harness-provided-cadence-ops-2026-06-26` P-005).
 *
 * When a harness ships dispatched cadence ops (`ops:` manifest, D-001), the
 * operator's routines engine must know WHERE the harness's sidecar listens so a
 * proxy CoordOp's `run()` can POST `/api/op/<name>` to it (`harnessApiBase` →
 * the LOCAL path). The sidecar advertises `{host,port,pid}` on boot to THIS route,
 * which persists it on the harness_registry project row (workspace PG) — the
 * durable registration path (survives operator restarts; generic across
 * harnesses; no home-dir-path guessing). A DEPLOYED harness uses
 * `frame.callablePort` instead and never calls this.
 *
 * `auth: 'loopback'` — a local sidecar advertises over loopback (the same gate the
 * sibling harness routes use). The advert is best-effort: if no project row exists
 * for the slug yet, it returns `{ok:false, reason}` (200) and the sidecar
 * re-advertises on its next boot.
 *
 * Body: { port: number, host?: string (default 127.0.0.1), pid?: number, ws?: string }
 */
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { registerHarnessLocalEndpoint } from '../../../harness-ops/transport';

const post = defineTool({
  method: 'POST',
  path: '/harness/:slug/endpoint',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    let body: { port?: unknown; host?: unknown; pid?: unknown; ws?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const port = Number(body.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return Response.json({ ok: false, error: 'port (1..65535) required' }, { status: 400 });
    }
    const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : '127.0.0.1';
    const pid = Number.isInteger(Number(body.pid)) ? Number(body.pid) : undefined;
    const workspaceId = typeof body.ws === 'string' && body.ws.trim() ? body.ws.trim() : activeWorkspaceId();

    const res = await registerHarnessLocalEndpoint(slug, { host, port, ...(pid != null ? { pid } : {}) }, workspaceId);
    return Response.json(res);
  },
});

export default [post];
