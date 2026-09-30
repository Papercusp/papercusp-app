/**
 * /api/admin/accounts/:verb — admin surface for the per-agent account PIN write
 * tools (hud-chat-owner-controls-2026-08-11 P-003).
 *
 * The GUI session chat's ACCOUNT pill lets the owner re-route the session this
 * chat is attached to onto a specific pool account, or back to gateway AUTO
 * routing, from the browser. Mirrors /api/admin/mode/:verb exactly (which
 * mirrors /api/admin/coord/:verb — the plans-admin-ui D-009 precedent): the
 * admin shell carries no bearer token, so this re-dispatches into the same
 * defineTool handler in-process via handleHttpToolRequest with a synthesized
 * superuser ctx, `?client=` pinned to ADMIN_COORD_UI_OWNER.
 *
 *   POST /api/admin/accounts/pin   { agent, account, hard? } → accounts:pin
 *   POST /api/admin/accounts/unpin { agent }                 → accounts:unpin
 *
 * ⚠ `accounts:set-session-override` is deliberately NOT reachable here. It reads
 * like the third member of this family and is not: it is a FLEET-WIDE steer over
 * which account NEW spawns get (accounts/session-override.ts), so wiring a
 * per-chat control to it would silently re-route the whole workspace. Plan
 * D-009's evidence block records that reading; the WRITE_VERBS set below is
 * where it is enforced.
 *
 * ⚠ The reply is forwarded WHOLESALE, and the caller MUST read it rather than
 * treating a 200 as success. `accounts:pin` returns `{ ok: true, appliedLive:
 * false, warn }` when the durable write landed but the live push to the running
 * gateway did not — the pin is real but is not in force until the gateway's next
 * poll. Collapsing that to "pinned" is exactly the accepted-but-modified case
 * plan D-008/D-009 §B require every one of these controls to model.
 */

import { handleHttpToolRequest } from '@papercusp/agent-mcp';
// Side-effect: register operator-side first-party tools (the accounts:* tools
// included). Same import the agent-tools catch-all + admin/mode use.
import '../../../agent-tools/index';
import { ADMIN_PROXY_HOST_EXTRAS as HOST_EXTRAS } from './proxy-host-extras';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { ADMIN_COORD_UI_OWNER } from '../../../agent-tools/coordination/identity';

const ADMIN_UI_CLIENT_ID = ADMIN_COORD_UI_OWNER;
const WRITE_VERBS = new Set(['pin', 'unpin']);

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
  // Same CSRF backstop as admin/mode.ts: a browser cross-origin POST is
  // refused; the desktop webview's allowed origins pass.
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;

  const verb = ctx.params.verb;
  if (!WRITE_VERBS.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `accounts write verb '${verb}' not found` } },
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
      pathname: `/api/agent-tools/accounts/${verb}`,
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
  path: '/admin/accounts/:verb',
  // Same trust set as admin/mode.ts's write route: the packaged Tauri desktop's
  // webview fetches the operator /api directly (loopback, no cookie/bearer), so
  // it resolves to 'unverified-loopback' — still an owner-local caller,
  // CSRF-gated above.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler: dispatchWrite,
});

export default [writeRoute];
