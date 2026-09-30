/**
 * /api/admin/coord/:verb — admin surface for the coord:* WRITE tools.
 *
 * The Planning-tab attention feed lets the human Resolve an escalation or
 * Ack a coord message — actions that until now only agents could do (via
 * the coord:resolve / coord:ack MCP tools; coord has only GET HTTP routes).
 * The admin shell carries no bearer token, so — exactly like
 * /api/admin/plans/:verb (plans-admin-ui D-009) — these routes re-dispatch
 * into the same defineTool handlers in-process via handleHttpToolRequest
 * with a synthesized superuser ctx. Authorization = the admin mount is
 * loopback-bound; `validateSuperuser` accepts the synthesized URL because
 * this route is its only caller.
 *
 * POST /api/admin/coord/resolve  { msg_id, choice, note? }  → coord:resolve
 * POST /api/admin/coord/ack      { msg_id }                 → coord:ack
 * POST /api/admin/coord/message-agent { to?, body, harness?, plan_slug?,
 *        item_ref?, title?, topics? }                        → coord:message-agent
 *   The inbox "Message owner" action — opens a work-item-scoped conversation
 *   with the owning agent (inbox-tiering-and-message-agent-2026-06-05, D-004).
 *   The inline thread is then read/posted via /api/admin/coordination/
 *   conversations/{get,post} (admin/coordination.ts allowlist).
 * POST /api/admin/coord/send { to[], summary, body?, wake?, plan_slug? }  → coord:send
 *   The cross-user HANDOFF/assign action (shared-hive-collaboration P-008):
 *   "assign this plan/item to @user" — deliver-and-wake the assignee
 *   (wake:true fires their inbox-wake). Sender is the admin UI owner.
 */

import { handleHttpToolRequest } from '@papercusp/agent-mcp';
// Side-effect: register operator-side first-party tools (the coord:* tools
// included). Same import the agent-tools catch-all + admin/plans use.
import '../../../agent-tools/index';
// WI-5364: shared extras carry the runScoped seam so proxied handlers that use
// ctx.tx get a real DB handle instead of 500ing "ctx.tx is not a function".
import { ADMIN_PROXY_HOST_EXTRAS as HOST_EXTRAS } from './proxy-host-extras';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { ADMIN_COORD_UI_OWNER } from '../../../agent-tools/coordination/identity';
import { applyOwnerMessageDefaults } from '../../../agent-tools/coordination/owner-message';

// Shared with the Planning inbox's ack-dismiss filter (plans/attention.ts) so
// "Acknowledge" actually dismisses: the human acks AS this owner here, and the
// reader drops messages acked BY this owner.
const ADMIN_UI_CLIENT_ID = ADMIN_COORD_UI_OWNER;
const WRITE_VERBS = new Set(['resolve', 'ack', 'message-agent', 'send']);

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
  // The unverified-loopback admission below relies on this CSRF backstop
  // (auth-posture.test.ts): a browser cross-origin POST is refused; the desktop
  // webview's allowed origins and no-Origin native/IPC-bridge fetches pass.
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;

  const verb = ctx.params.verb;
  if (!WRITE_VERBS.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `coord write verb '${verb}' not found` } },
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
  // P-033: a GUI sender is not an agent and cannot author the protocol fields
  // coord:send now requires — D-048 made `expects` REQUIRED with no default, and
  // every GUI call site (the HUD session chat, the Agents-pill composer + nudge)
  // posts without it, so all three have been failing validation since it landed.
  // The wrapper fills the gaps HONESTLY and STAMPS what it filled, so the D-070
  // measurement never counts a GUI-derived value as sender intent. Applied here,
  // at the one route every GUI sender already goes through, rather than at each
  // call site — three are broken today and patching them one by one leaves the
  // trap armed for the fourth.
  const dispatchBody = verb === 'send' ? applyOwnerMessageDefaults(body) : body;
  const url = new URL(req.url);
  const result = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: `/api/agent-tools/coord/${verb}`,
      searchParams: adminSearchParams(url.searchParams),
      headers: collectHeaders(req),
      body: dispatchBody,
    },
    HOST_EXTRAS,
  );
  return unwrap(result);
}

const writeRoute = defineTool({
  method: 'POST',
  path: '/admin/coord/:verb',
  // Mutating coord ops — gate to the admin tier (the admin coord UI runs as a
  // verified session). Was 'public', which the D3 auth-posture guard flags.
  //
  // 'unverified-loopback' (owner-hit 2026-07-11: roster bulk "send message" +
  // "wake" 403'd): a packaged/nohmr Tauri desktop's webview fetches the operator
  // /api DIRECTLY (loopback, no cookie/bearer) so it only ever resolves to
  // 'unverified-loopback' trust — never 'verified'. Every other desktop-callable
  // admin route (deploy-accounts-reset, inference-gateway-stats,
  // dogfood-substrate-health) already admits it for exactly this reason; the
  // operator binds loopback-only, so this is still an owner-local caller. Without
  // it the roster's coord actions were unreachable from the desktop app.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler: dispatchWrite,
});

export default [writeRoute];
