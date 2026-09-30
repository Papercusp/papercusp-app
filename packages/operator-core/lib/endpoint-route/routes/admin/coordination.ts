/**
 * /api/admin/coordination/:group/:verb — the coordination admin UI's data + write
 * surface (integration-adoption-2026-06-03, Capstone P2).
 *
 * The admin shell carries no bearer token, so — exactly like /api/admin/coord +
 * /api/admin/plans — these routes re-dispatch into the same defineTool MCP
 * handlers in-process via handleHttpToolRequest with a synthesized superuser ctx.
 * This powers the Topics / Conversations / Issues admin views over the SAME tools
 * the agents use: issues:* (su-a5a32), topics:* (su-30a41), conversations:* +
 * coord:ask (su-9fd2d). One generic proxy — no duplicated read handlers, no
 * second data path to drift.
 *
 * The UI POSTs the tool args as the JSON body, e.g.
 *   POST /api/admin/coordination/issues/list      { state: 'open' }
 *   POST /api/admin/coordination/topics/feed       { topic: 'zero-cache' }
 *   POST /api/admin/coordination/conversations/list {}
 */
import {
  handleHttpToolRequest,
  defineTool,
  type RouteContext,
} from '@papercusp/agent-mcp';
// Side-effect: register the operator-side first-party tools (issues:* / topics:* /
// conversations:* included). Same import admin/coord + admin/plans use.
import '../../../agent-tools/index';
import { ADMIN_COORD_UI_OWNER } from '../../../agent-tools/coordination/identity';
import { requireAllowedOriginOr403 } from '../../cors';
// WI-5364: shared extras carry the runScoped seam so proxied handlers that use
// ctx.tx (sessions:list was the first) get a real DB handle instead of 500ing.
import { ADMIN_PROXY_HOST_EXTRAS as HOST_EXTRAS } from './proxy-host-extras';

// The coordination tool surface the admin UI may proxy. Allowlisted so the admin
// mount can't be used to reach arbitrary tools.
const ALLOWED: Record<string, ReadonlySet<string>> = {
  issues: new Set(['list', 'get', 'search', 'create', 'update', 'comment', 'claim', 'release', 'close', 'tag', 'subscribe', 'link', 'promote']),
  topics: new Set(['list', 'feed', 'create', 'subscribe', 'unsubscribe', 'merge', 'tag']),
  conversations: new Set(['list', 'get', 'post', 'answer', 'resolve', 'join', 'promote']),
  coord: new Set(['ask']),
  // D-027 follow-on (1): the Queue's inline improvement Dismiss → improvements:triage
  // (triage-one reject). Only triage is exposed — capture/resolve are agent-loop verbs.
  improvements: new Set(['triage']),
  // owner-inbox-single-pane-2026-07-17 P-007: resolve "which session is this
  // inbox item's ownerAgentId currently on" (SessionChatModal's owner→session
  // lookup, ahead of the live /api/adv/session/thinking stream). Read-only —
  // only `list` is exposed, never `read`/`search` (those return turn TEXT,
  // which this admin mount has no reason to proxy).
  sessions: new Set(['list']),
  // WI-38039: the session pane needs the same audited owner-targeted kill
  // primitive as agents do, but the desktop webview has no bearer token. Keep
  // the loopback + origin-checked admin proxy narrow to this one verb; the
  // underlying fleet:kill tool still owns identity, audit, and target safety.
  fleet: new Set(['kill']),
};

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
  if (!sp.has('client')) sp.set('client', ADMIN_COORD_UI_OWNER);
  return sp;
}

async function dispatch(req: Request, ctx: RouteContext): Promise<Response> {
  // The 'unverified-loopback' admission on the route below relies on this CSRF
  // backstop, exactly as /admin/coord's write dispatch does (auth-posture.test.ts):
  // a browser cross-origin POST is refused, while the desktop webview's allowed
  // origins and its no-Origin native/IPC-bridge fetches pass. The backstop is what
  // makes admitting a cookie-less caller safe on a proxy that reaches write verbs
  // (topics:create, conversations:post/answer/resolve, coord:ask).
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;

  const group = String(ctx.params.group);
  const verb = String(ctx.params.verb);
  if (!ALLOWED[group]?.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `coordination verb '${group}:${verb}' is not allowed here` } },
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
      pathname: `/api/agent-tools/${group}/${verb}`,
      searchParams: adminSearchParams(url.searchParams),
      headers: collectHeaders(req),
      body,
    },
    HOST_EXTRAS,
  );
  return unwrap(result);
}

const route = defineTool({
  method: 'POST',
  path: '/admin/coordination/:group/:verb',
  // The admin coordination UI runs as a verified loopback session.
  //
  // 'unverified-loopback' (WI-6486, owner-hit 2026-07-27: the HUD conversation
  // pane 403-blanked): a Tauri desktop webview fetches the operator /api DIRECTLY
  // over loopback with no cookie/bearer, so it only ever resolves to
  // 'unverified-loopback' — never 'verified'. This is the SAME diagnosis and the
  // same remedy /admin/coord took on 2026-07-11 for the roster's send/wake, and
  // the operator binds loopback-only, so the caller is still owner-local.
  //
  // ⚠ WHY THIS MOUNT MATTERED MORE THAN THE OTHERS: hud-consolidation-2026-07-26
  // (D-001) RETIRED the sidebar Inbox on the grounds that every ask it surfaced
  // "now opens as a HUD conversation instead" — and `sessions:list` here is that
  // conversation's owner→session lookup. So this 403 removed the only surface for
  // a human ask, with no fallback left to fall back to. A route added for the
  // cookie'd admin shell became load-bearing for the cookie-less desktop webview,
  // and nothing re-checked the trust tier when the dependency moved.
  //
  // Safe because `dispatch` opens with the requireAllowedOriginOr403 CSRF backstop
  // — see the comment there; without it this admission would expose the proxy's
  // write verbs to a cross-origin browser POST.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler: dispatch,
});

export default [route];
