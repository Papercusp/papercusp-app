/**
 * POST /api/deploy/:slug/vnc-session → { ok, ticket, wsUrl, mode, display }
 *
 * Mint a single-use frame-VNC session ticket
 * (`hive-frame-desktops-live-view-2026-06-06` P-008/P-009/P-010, D-002).
 * Body: { display: number, mode?: 'watch' | 'takeover' } — `watch` (default)
 * is read-only (`x11vnc -viewonly`); `takeover` hands the viewer the mouse +
 * keyboard and is audited as such. The returned wsUrl points at the operator's
 * loopback VNC bridge; noVNC connects there and the ticket is consumed once.
 *
 * Auth: `getSessionUserOrDefault` — the desktop webview is cookie-less
 * (loopback bind is the perimeter; see auth.ts header + auth/me), so a strict
 * session gate 401s the shipping desktop. The resolved user (real session or
 * the single-user `default`) feeds the audit `actor`. Belt-and-braces: the
 * loopback perimeter is also declared as `auth: 'loopback'` (enforced at the
 * route-stack authStep) — this route mints input-takeover tickets, so a
 * listener-bind misconfiguration must never expose it off-box.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  createVncSession,
  startFrameVncWs,
  VNC_WS_PATH,
} from '../../../deployment/frame-vnc';

export default defineTool({
  method: 'POST',
  path: '/deploy/:slug/vnc-session',
  auth: 'loopback',
  async handler(req, ctx) {
    const user = await getSessionUserOrDefault(req.headers);
    const slug = ctx.params.slug as string;
    let body: { display?: unknown; mode?: unknown; target?: unknown };
    try {
      body = (await req.json()) as { display?: unknown; mode?: unknown; target?: unknown };
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const display = Number(body.display);
    if (!Number.isInteger(display) || display < 0 || display > 9999) {
      return Response.json({ ok: false, error: 'display must be a display number (e.g. 99)' }, { status: 400 });
    }
    const mode = body.mode === 'takeover' ? 'takeover' : 'watch';
    // 'frame' stays the default so every pre-P-004 caller keeps its behaviour.
    // A local session is refused unless the display is a REGISTERED agent
    // desktop — createVncSession enforces that; the route does not second-guess
    // it, so there is exactly one place the admission rule lives.
    const target = body.target === 'local' ? 'local' : 'frame';

    const port = await startFrameVncWs();
    if (!port) {
      return Response.json({ ok: false, error: 'vnc bridge failed to bind' }, { status: 503 });
    }
    try {
      const ticket = await createVncSession({
        slug,
        workspaceId: activeWorkspaceId(),
        display,
        mode,
        target,
        actor: `user:${user.username}`,
      });
      return Response.json({
        ok: true,
        ticket: ticket.ticket,
        wsUrl: `ws://127.0.0.1:${port}${VNC_WS_PATH}?ticket=${ticket.ticket}`,
        mode,
        display,
        slug,
        target,
        desktopSessionId: ticket.desktopSessionId,
      });
    } catch (e) {
      return Response.json(
        { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) },
        { status: 409 },
      );
    }
  },
});
