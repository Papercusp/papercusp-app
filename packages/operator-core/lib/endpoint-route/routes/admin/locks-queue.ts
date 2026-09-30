/**
 * GET /api/admin/locks/queue — admin proxy for the locks:queue tool.
 *
 * Used by the Plans admin tab's lock banner (P-205 of
 * plans-admin-ui-2026-05-20.md) to show when another shell holds the
 * open plan's file. Same in-process dispatch pattern as
 * /api/admin/plans/* (D-009): re-dispatch into the defineTool handler
 * via handleHttpToolRequest so we get the tool's audit/telemetry path,
 * not a side-channel.
 *
 * `paths` is a repeated query param: ?paths=a&paths=b. The locks:queue
 * tool's args schema accepts `paths: string[]`.
 */

import { handleHttpToolRequest } from '@papercusp/agent-mcp';
import '../../../agent-tools/index';
// WI-5364: shared extras carry the runScoped seam so proxied handlers that use
// ctx.tx get a real DB handle instead of 500ing "ctx.tx is not a function".
import { ADMIN_PROXY_HOST_EXTRAS as HOST_EXTRAS } from './proxy-host-extras';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';

// Admin proxy identity: locks:queue calls readIdentity(ctx) for
// attribution, which requires power-user / superuser / principal.
// Mirror /api/admin/plans/* (D-009): synthesize `?superuser=1` +
// `?client=…` and accept it via validateSuperuser, gated by the route
// being loopback-bound like every other /admin/* endpoint.
const ADMIN_UI_CLIENT_ID = 'pc-admin-plans-ui';

async function handler(req: Request, _ctx: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  const headerMap: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => {
    headerMap[k.toLowerCase()] = v;
  });
  // locks:queue registers `methods: ['POST']` like every defineTool
  // projection — we dispatch internally as POST and construct the body
  // from searchParams so the browser can keep cacheable GETs. `paths`
  // is the only multi-value param.
  const paths = url.searchParams.getAll('paths');
  const owner = url.searchParams.get('owner');
  const includeCompleted = url.searchParams.get('include_completed');
  const body: Record<string, unknown> = {};
  if (paths.length) body.paths = paths;
  if (owner) body.owner = owner;
  if (includeCompleted === 'true') body.include_completed = true;
  const adminSp = new URLSearchParams(url.searchParams);
  adminSp.set('superuser', '1');
  if (!adminSp.has('client')) adminSp.set('client', ADMIN_UI_CLIENT_ID);
  const result = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: '/api/agent-tools/locks/queue',
      searchParams: adminSp,
      headers: headerMap,
      body,
    },
    HOST_EXTRAS,
  );
  if (result.status === 200) {
    const body = result.body as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.find((c) => c.type === 'text')?.text;
    if (text !== undefined) {
      try {
        return Response.json(JSON.parse(text));
      } catch {
        return new Response(text, { headers: { 'content-type': 'text/plain' } });
      }
    }
    return Response.json({ active_locks: [], waiting: [] });
  }
  return Response.json(result.body, { status: result.status });
}

export default defineTool({
  method: 'GET',
  path: '/admin/locks/queue',
  // Admin lock-queue view (verified admin/plans UI); gated per D3 (was 'public').
  // The public lock-visibility surface for agents is the MCP `locks:queue` tool,
  // not this HTTP admin route.
  auth: { trust: ['verified', 'trusted'] },
  handler,
});
