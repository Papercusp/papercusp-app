/**
 * /api/admin/mode/:verb — admin surface for the mode:* WRITE tools.
 *
 * The GUI session chat's posture actions (Autonomy radio, Overlays checkboxes
 * — gui-chat-session-controls-2026-07-25 P-003/P-004) let the human set an
 * agent's official session mode (mode:set) from the browser, carrying
 * ownerDirected:true so the change arms the owner-sticky guard. Mirrors
 * /api/admin/coord/:verb exactly (plans-admin-ui D-009 precedent): the admin
 * shell carries no bearer token, so this re-dispatches into the same
 * defineTool handler in-process via handleHttpToolRequest with a synthesized
 * superuser ctx, `?client=` pinned to ADMIN_COORD_UI_OWNER.
 *
 * mode:set's tool-layer handler checks `ident.ownerId === ADMIN_COORD_UI_OWNER`
 * (never a client-suppliable flag) to grant this route verified owner
 * authority for a PEER-set — the same identity this route already uses for
 * coord:resolve/ack/send, so acking a coord message and setting a posture mode
 * from the same admin session are attributed identically.
 *
 * POST /api/admin/mode/set { mode, reason, enabled?, instructions?, agent?, ownerDirected? } → mode:set
 *
 * The body is forwarded WHOLESALE to the tool, so `instructions` (P-005: drain
 * scope that must survive compaction) needed no change here — it is listed
 * because this comment is the route's field contract, and a reader checking
 * whether the browser can reach a mode:set argument should not have to infer it
 * from the absence of a filter.
 */

import { handleHttpToolRequest } from '@papercusp/agent-mcp';
// Side-effect: register operator-side first-party tools (the mode:* tools
// included). Same import the agent-tools catch-all + admin/coord use.
import '../../../agent-tools/index';
import { ADMIN_PROXY_HOST_EXTRAS as HOST_EXTRAS } from './proxy-host-extras';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { ADMIN_COORD_UI_OWNER } from '../../../agent-tools/coordination/identity';

const ADMIN_UI_CLIENT_ID = ADMIN_COORD_UI_OWNER;
const WRITE_VERBS = new Set(['set']);

function unwrap(toolResult: { status: number; body: unknown }): Response {
  if (toolResult.status === 200) {
    const body = toolResult.body as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.find((c) => c.type === 'text')?.text;
    if (text !== undefined) {
      try {
        return Response.json(JSON.parse(text));
      } catch {
        return new Response(text, { headers: { 'content-type': 'text/plain' } });
      }
    }
    return Response.json({});
  }
  return Response.json(toolResult.body, { status: toolResult.status });
}

function collectHeaders(req: Request): Record<string, string | undefined> {
  const m: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => {
    m[k.toLowerCase()] = v;
  });
  return m;
}

function adminSearchParams(inbound: URLSearchParams): URLSearchParams {
  const sp = new URLSearchParams(inbound);
  sp.set('superuser', '1');
  if (!sp.has('client')) sp.set('client', ADMIN_UI_CLIENT_ID);
  return sp;
}

async function dispatchWrite(req: Request, ctx: RouteContext): Promise<Response> {
  // Same CSRF backstop as admin/coord.ts: a browser cross-origin POST is
  // refused; the desktop webview's allowed origins pass.
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;

  const verb = ctx.params.verb;
  if (!WRITE_VERBS.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `mode write verb '${verb}' not found` } },
      { status: 404 },
    );
  }
  let body: Record<string, unknown> = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { code: 'invalid_json', message: 'request body must be JSON' } }, { status: 400 });
  }
  const url = new URL(req.url);
  const result = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: `/api/agent-tools/mode/${verb}`,
      searchParams: adminSearchParams(url.searchParams),
      headers: collectHeaders(req),
      body,
    },
    HOST_EXTRAS,
  );
  return unwrap(result);
}

const writeRoute = defineTool({
  method: 'POST',
  path: '/admin/mode/:verb',
  // Same trust set as admin/coord.ts's write route: the packaged Tauri
  // desktop's webview fetches the operator /api directly (loopback, no
  // cookie/bearer), so it resolves to 'unverified-loopback' — still an
  // owner-local caller, CSRF-gated above.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler: dispatchWrite,
});

export default [writeRoute];
