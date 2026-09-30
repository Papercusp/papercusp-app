/**
 * POST /api/admin/coord-inbox-reply — deliver an owner-authored Inbox reply
 * to its LIVE asker, with authoritative turn-provenance
 * (owner-inbox-single-pane-2026-07-17 P-006, D-006/D-007).
 *
 * Deliberately NOT a verb of the generic `/admin/coord/:verb` → coord:send
 * proxy (admin/coord.ts): the `coord-inject:owner` turn-provenance origin
 * this mints (see ../../agent-tools/coordination/inbox-reply.ts) must never
 * be reachable through the general-purpose, agent-callable `coord:send` MCP
 * tool — any agent could otherwise forge an "owner directive" to a peer.
 * This route calls the library function directly and is NOT registered as a
 * defineTool in the agent-tools catalog; only the admin-UI-authenticated
 * caller (loopback/verified trust, same posture as `/api/admin/coord/*`)
 * can reach it.
 *
 * Body: { askerId, text, summary?, planSlug? }
 * → { ok, live, delivered, woken, msgId? }
 */

import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { deliverInboxOwnerReply } from '../../../agent-tools/coordination/inbox-reply';

async function handler(req: Request, _ctx: RouteContext): Promise<Response> {
  // The VTL posture below relies on this CSRF backstop (auth-posture.test.ts):
  // a browser cross-origin POST is refused; the desktop webview's allowed
  // origins and no-Origin native/IPC-bridge fetches pass through.
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;

  let body: Record<string, unknown> = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: { code: 'invalid_json', message: 'request body must be JSON' } },
      { status: 400 },
    );
  }
  const askerId = typeof body.askerId === 'string' ? body.askerId.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!askerId || !text) {
    return Response.json(
      { error: { code: 'missing_fields', message: 'askerId and text are required' } },
      { status: 400 },
    );
  }
  const summary =
    typeof body.summary === 'string' && body.summary.trim() ? body.summary.trim() : text.slice(0, 200);
  const planSlug = typeof body.planSlug === 'string' ? body.planSlug : undefined;
  try {
    const res = await deliverInboxOwnerReply({ askerId, text, summary, planSlug });
    return Response.json({ ok: true, ...res });
  } catch (e) {
    return Response.json(
      { error: { code: 'inbox_reply_failed', message: e instanceof Error ? e.message : String(e) } },
      { status: 500 },
    );
  }
}

const route = defineTool({
  method: 'POST',
  path: '/admin/coord-inbox-reply',
  // Same admin-tier posture as admin/coord.ts (the desktop webview hits the
  // operator loopback with no cookie/bearer, so 'unverified-loopback' must
  // stay admitted for the packaged Tauri app to reach this).
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler,
});

export default [route];
