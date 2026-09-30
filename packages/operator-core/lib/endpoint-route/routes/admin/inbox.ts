/**
 * /api/admin/inbox/:verb — admin surface for the inbox:* WRITE tools.
 *
 * The Planning-tab attention feed lets the human Resolve an operator-report
 * item (report-cards-inbox-reconciliation-2026-06-05 P-007) — that resolve IS
 * the triage state machine (inbox-tiering-and-message-agent D-006:
 * resolve → handled tier, auditable, never a silent vanish). Exactly like
 * /api/admin/coord/:verb, this re-dispatches into the same defineTool handler
 * in-process via handleHttpToolRequest with a synthesized superuser ctx;
 * authorization = the admin mount is loopback-bound.
 *
 * POST /api/admin/inbox/triage { itemId, action, note? } → inbox:triage
 */

import { handleHttpToolRequest } from '@papercusp/agent-mcp';
// Side-effect: register operator-side first-party tools (the inbox:* tools
// included). Same import the agent-tools catch-all + admin/plans use.
import '../../../agent-tools/index';
// WI-5364: shared extras carry the runScoped seam so proxied handlers that use
// ctx.tx get a real DB handle instead of 500ing "ctx.tx is not a function".
import { ADMIN_PROXY_HOST_EXTRAS as HOST_EXTRAS } from './proxy-host-extras';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { ADMIN_COORD_UI_OWNER } from '../../../agent-tools/coordination/identity';

// The human triages AS the admin UI owner — same identity the coord proxy
// uses, so triage audit rows (`triaged_by`) attribute consistently.
const ADMIN_UI_CLIENT_ID = ADMIN_COORD_UI_OWNER;
const WRITE_VERBS = new Set(['triage']);

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
  const verb = ctx.params.verb;
  if (!WRITE_VERBS.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `inbox write verb '${verb}' not found` } },
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
      pathname: `/api/agent-tools/inbox/${verb}`,
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
  path: '/admin/inbox/:verb',
  // Mutating triage ops — gate to the admin tier, same posture as admin/coord.
  auth: { trust: ['verified', 'trusted'] },
  handler: dispatchWrite,
});

export default [writeRoute];
