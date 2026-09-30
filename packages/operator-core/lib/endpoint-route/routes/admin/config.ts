/**
 * /api/admin/config/:verb — admin surface for the config:* WRITE tools.
 *
 * The GUI session chat's CTX pill (hud-chat-owner-controls-2026-08-11, WI-6507
 * — [owner 2026-07-27] "add a button to the buttom of the chats to adjust
 * the token limit") lets the human set an agent session's soft COMPACTION
 * LIMIT from the chat footer. Mirrors /api/admin/mode/:verb exactly: the admin
 * shell carries no bearer token, so this re-dispatches into the same defineTool
 * handler in-process via handleHttpToolRequest with a synthesized superuser ctx,
 * `?client=` pinned to ADMIN_COORD_UI_OWNER.
 *
 * WHY THE IDENTITY MATTERS HERE. The chat footer sets ANOTHER session's limit,
 * never its own, so every call takes config:set-compaction-limit's cross-owner
 * branch (setCompactionLimitForOwner), which is gated to the target's fleet
 * leader / queen / owner. `pc-admin-coord-ui` has no presence row and no `su-`
 * prefix, so classifyAgentPane lands it on `cup` and the gate refuses. That core
 * therefore grants ADMIN_COORD_UI_OWNER owner authority explicitly — the same
 * allowance mode:set already makes at its own tool layer. Without BOTH halves
 * (this route's pinned client id, and that grant) the control renders fine and
 * silently writes nothing.
 *
 * POST /api/admin/config/set-compaction-limit { limit, ownerId } → config:set-compaction-limit
 *
 * The body is forwarded WHOLESALE to the tool. Note the tool answers a REFUSAL
 * in a 200 body (`ok:false` + `error:'limit_exceeds_cap'` + the live `cap`), so
 * a caller that only checks HTTP status will read a refused write as a success —
 * see hud-chat-owner-controls-2026-08-11#D-010.
 */

import { handleHttpToolRequest } from '@papercusp/agent-mcp';
// Side-effect: register operator-side first-party tools (the config:* tools
// included). Same import the agent-tools catch-all + admin/mode use.
import '../../../agent-tools/index';
import { ADMIN_PROXY_HOST_EXTRAS as HOST_EXTRAS } from './proxy-host-extras';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { ADMIN_COORD_UI_OWNER } from '../../../agent-tools/coordination/identity';

const ADMIN_UI_CLIENT_ID = ADMIN_COORD_UI_OWNER;
const WRITE_VERBS = new Set(['set-compaction-limit']);

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
      { error: { code: 'unknown_verb', message: `config write verb '${verb}' not found` } },
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
      pathname: `/api/agent-tools/config/${verb}`,
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
  path: '/admin/config/:verb',
  // Same trust set as admin/mode.ts's write route: the packaged Tauri desktop's
  // webview fetches the operator /api directly (loopback, no cookie/bearer), so
  // it resolves to 'unverified-loopback' — still an owner-local caller, CSRF-gated
  // above.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler: dispatchWrite,
});

export default [writeRoute];
