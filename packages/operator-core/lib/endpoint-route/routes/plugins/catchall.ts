/**
 * GET/POST/PUT/PATCH/DELETE /api/plugins/* — two-step catch-all.
 *
 * 1. First try the in-memory plugin-`apiRoutes` registry: if the first
 *    path segment after `/plugins/` is a registered plugin's safe-name,
 *    forward the request to that plugin's handler (relocated from the
 *    Hono-sub-app `installPluginApiDispatcher`, endpoint-hono-elimination
 *    -2026-05-21 A3).
 * 2. Otherwise, fall through to projected-tool dispatch — every plugin
 *    tool with `expose.http.path` starting with `/api/plugins/` is served
 *    here.
 *
 * `auth: 'public'` — gates live inside the tool definition / plugin
 * handler, not at the route level.
 */
import {
  handleHttpToolRequest,
  handleHttpToolRequestStreaming,
  lookupByHttpPath,
  buildHttpSpawnContext,
  type HttpToolHostExtras,
} from '@papercusp/agent-mcp';
import { sseResponse } from '@papercusp/sse';
import { dispatchPluginApiRoute } from '../../../plugin-api-mount';
import { pluginSpawnImpl, secretImpl, makeSecretResolver } from '../../../plugin-spawn-impl';
import { resolveHarnessPaths } from '../../../resolve-harness-paths';
import { isLoopbackRequest, isValidSuperuserBearer } from '../../../superuser-token';
import { PROJECTED_DEPS } from '../../../projected-tool-deps';
import { defineTool } from '@papercusp/agent-mcp';

const HOST_EXTRAS: HttpToolHostExtras = {
  deps: PROJECTED_DEPS,
  log: (line, ctx) => {
     
    console.log(`[plugin-tool/http][${ctx.harnessSlug ?? '-'}/${ctx.role ?? '-'}/${ctx.spawnId ?? '-'}] ${line}`);
  },
  spawn: pluginSpawnImpl,
  secret: secretImpl,
  resolveHarnessPaths,
  validateSuperuser: (req) => {
    const h = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') h.set(k, v);
    }
    if (!isLoopbackRequest(h)) return false;
    const auth = req.headers['authorization'] ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    return isValidSuperuserBearer(bearer);
  },
};

async function dispatchHttp(req: Request): Promise<Response> {
  // Step 1: plugin-`apiRoutes` registry. Returns the plugin's Response,
  // or null on registry miss — fall through to projected-tool dispatch.
  const pluginResponse = await dispatchPluginApiRoute(req);
  if (pluginResponse) return pluginResponse;

  const url = new URL(req.url);

  let body: unknown = {};
  if (req.method !== 'GET') {
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
  }

  const headerMap: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => { headerMap[k.toLowerCase()] = v; });

  const transportReq = {
    method: req.method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    headers: headerMap,
    body,
  };

  // Per-request, plugin-scoped secret resolver (revive-plugin-system D-004):
  // ctx.secret reads the calling plugin's encrypted plugin_configs first, then
  // env. Each /api/plugins/* request targets one tool, so we can bind the
  // resolver to that tool's owning plugin + the request's harness here.
  const tool = lookupByHttpPath(url.pathname);
  const pluginName = tool?.pluginName;
  const extras: HttpToolHostExtras =
    pluginName && pluginName !== 'agent-mcp'
      ? {
          ...HOST_EXTRAS,
          secret: makeSecretResolver({
            harnessSlug:
              buildHttpSpawnContext({ headers: headerMap, searchParams: url.searchParams })
                .harnessSlug ?? '*',
            pluginName,
          }),
        }
      : HOST_EXTRAS;

  const wantsStream = (headerMap['accept'] ?? '').includes('text/event-stream');

  if (wantsStream) {
    const streamable =
      !!tool &&
      ((tool.events && Object.keys(tool.events).length > 0) ||
        tool.expose.mcp?.streaming === true);
    if (!streamable) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'not_acceptable',
            message: 'tool does not stream; retry with Accept: application/json',
          },
        }),
        { status: 406, headers: { 'content-type': 'application/json' } },
      );
    }
    return sseResponse({
      signal: req.signal,
      setup: (sink) => handleHttpToolRequestStreaming(transportReq, extras, sink),
    });
  }

  const result = await handleHttpToolRequest(transportReq, extras);
  // A 404 here may actually be a KNOWN literal plugin route (e.g. POST-only
  // /plugins/enable) hit with the wrong verb — the `/plugins/*` catch-all
  // shadows it for non-matching methods, so the global 405 `notFound` hook
  // never runs. Upgrade to 405 (with Allow) when the path matches a registered
  // route under a different method. Catch-alls are excluded from the matcher,
  // so a genuinely unknown /plugins/* path stays 404.
  if (result.status === 404) {
    const rel = url.pathname.replace(/^\/api/, '') || '/';
    // The resolver reads ALL_ROUTES. Loading it during route declaration
    // creates catchall -> resolver -> registry -> catchall and captures this
    // module's unfinished export when the catch-all is imported first.
    const { allowedMethodsFor } = await import('../../method-not-allowed');
    const allowed = allowedMethodsFor(rel);
    const eff = req.method === 'HEAD' ? 'GET' : req.method;
    if (allowed.length > 0 && !allowed.includes(eff)) {
      return new Response(JSON.stringify({ error: 'method_not_allowed', allow: allowed }), {
        status: 405,
        headers: { 'content-type': 'application/json', Allow: allowed.join(', ') },
      });
    }
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
}

const PATH = '/plugins/*';
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export default methods.map((method) =>
  defineTool({
    method,
    path: PATH,
    auth: 'public',
    // Tool transport — streamed plugin calls outlive any fixed route budget;
    // dispatch enforces its own per-tool timeouts (EI-110).
    timeoutSec: null,
    handler: dispatchHttp,
  }),
);
