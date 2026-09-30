/**
 * GET/POST/PUT/PATCH/DELETE /api/agent-tools/<group>/<verb>
 *
 * Catch-all HTTP route for the 27+ built-in agent-mcp tools via
 * defineTool's auto-mounted projection. Honors SSE for streamable tools.
 *
 * Auth (Phase E2, endpoint-unification-2026-05-21): the bearer is
 * resolved by a COMPOSITE — `resolveBearer` (token_index: agent
 * `system`/`pi` principals) first, then a mobile device JWT. Both
 * arrive as `Authorization: Bearer <token>`, so one hook reaches both.
 * This is the load-bearing fix that lets a paired phone call a
 * built-in `defineTool` directly (gaining capability gates + quotas +
 * audit for free) instead of going through the legacy `_hono/mobile.ts`
 * `/voice-tool/:name` proxy.
 *
 * Ported from app/api/agent-tools/[...path]/route.ts. `auth: 'public'`.
 */
import {
  handleHttpToolRequest,
  handleHttpToolRequestStreaming,
  lookupByHttpPath,
  resolveBearer,
  type HttpToolHostExtras,
  type Principal,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { sseResponse } from '@papercusp/sse';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';

// Side-effect: register operator-side first-party tools (defineTool calls).
import '../../../agent-tools/index';
import { PROJECTED_DEPS } from '../../../projected-tool-deps';
import { chooseScopedHandle, isWorkspaceIsolationEnabled } from './scoped-handle';
import { principalFromDeviceJwt } from '../../../auth/principal/from-device-jwt';
import { resolveAppKeyToken } from '../../../connected-apps/principal';
import { isLoopbackRequest, isValidSuperuserBearer } from '../../../superuser-token';
import { defineTool } from '@papercusp/agent-mcp';

const HOST_EXTRAS: HttpToolHostExtras = {
  // `?superuser=1` admission for built-in tools over HTTP — same gate the
  // /api/plugins/* catch-all carries (loopback origin + the on-disk bearer).
  // Without this the framework's superuser check has no validator and every
  // `?superuser=1` call here was rejected, so an SU shell could reach a
  // built-in tool via MCP but not via its projected HTTP path (e.g. the
  // cup:spawn admin trigger, Brief 4 of agent-briefs-2026-06-05).
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
  resolvePrincipalAndTx: async (bearer) => {
    // An app key (`pcapp_…`, external-app-access P-002) is resolved by its own
    // store and is TERMINAL: a key that does not verify is refused here, never
    // retried as an agent bearer or a device JWT.
    const appKey = await resolveAppKeyToken(bearer);
    if (appKey && !appKey.ok) return null;
    // Composite resolution otherwise: agent bearer (token_index → system/pi)
    // first, then the mobile device JWT. `resolveBearer` hits PG; a transient
    // PG failure must not block the self-contained (HMAC-verified) mobile
    // path, so its errors fall through rather than propagate.
    let principal: Principal | null = appKey?.principal ?? null;
    if (!principal) {
      try {
        principal = await resolveBearer(bearer);
      } catch {
        /* token_index unreachable — fall through to the mobile JWT path */
      }
    }
    // `principalFromDeviceJwt` reads the `Authorization` header, so
    // synthesize one from the bearer string. Async — it also runs the
    // device-revocation check.
    principal ??= await principalFromDeviceJwt(
      new Headers({ authorization: `Bearer ${bearer}` }),
    );
    if (!principal) return null;
    const { sql } = getOrgPg();
    return {
      principal: {
        slug: principal.slug,
        workspaceId: principal.workspaceId,
        // Principal.capabilities is ReadonlySet; the unified ctx wants a
        // mutable Set — copy so the type lines up without a cast.
        capabilities: new Set(principal.capabilities),
      },
      tx: sql,
    };
  },
  runScoped: (scope, run) => {
    // P-062 Phase 4 — workspace isolation is ON by default (kill-switch
    // PAPERCUSP_AGENT_TOOLS_WS_ISOLATION='0'; see isWorkspaceIsolationEnabled).
    // The dispatch stack's own bookkeeping (tool_invocations + quota) runs on
    // the admin handle inside PROJECTED_DEPS, NOT on ctx.tx, so this seam only
    // changes the handle the tool HANDLER reads. The admin-vs-workspace decision
    // matrix is the pure, unit-tested `chooseScopedHandle`; here we only wire it
    // to the real PG.
    //   admin     → getOrgPg() (rolbypassrls) — flag-off / superuser /
    //               crossWorkspace tools / no concrete workspace.
    //   workspace → withWorkspace(ws) (harness_app role + GUC) so RLS isolates
    //               the tool to its own workspace.
    const choice = chooseScopedHandle(scope, { isolationOn: isWorkspaceIsolationEnabled() });
    if (choice.kind === 'admin') return run(getOrgPg().sql);
    return withWorkspace(choice.workspaceId, (tx) => run(tx));
  },
  deps: PROJECTED_DEPS,
  log: (line, ctx: UnifiedToolContext) => {
     
    console.log(`[agent-tool/http][${ctx.principal?.slug ?? '-'}/${ctx.role ?? '-'}] ${line}`);
  },
};

async function dispatchHttp(req: Request): Promise<Response> {
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

  const wantsStream = (headerMap['accept'] ?? '').includes('text/event-stream');

  if (wantsStream) {
    const tool = lookupByHttpPath(url.pathname);
    const streamable =
      !!tool &&
      ((tool.events && Object.keys(tool.events).length > 0) ||
        !!tool.state ||
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

    const clientRunId = (headerMap['x-papercusp-run-id'] ?? '').trim();
    const runId = clientRunId.length > 0
      ? clientRunId
      : (globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    url.searchParams.set('run', runId);
    transportReq.searchParams = url.searchParams;

    return sseResponse({
      signal: req.signal,
      headers: { 'X-Papercusp-Run-Id': runId },
      setup: (sink) => handleHttpToolRequestStreaming(transportReq, HOST_EXTRAS, sink),
    });
  }

  const result = await handleHttpToolRequest(transportReq, HOST_EXTRAS);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
}

const PATH = '/agent-tools/*';
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export default methods.map((method) =>
  defineTool({
    method,
    path: PATH,
    auth: 'public',
    // Tool transport — streamed tool calls outlive any fixed route budget,
    // and non-streamed dispatch enforces its own per-tool timeoutSec /
    // idleTimeoutSec. The route-stack watchdog is redundant here and 408'd
    // healthy streams (EI-110).
    timeoutSec: null,
    // Phase E3 — the phone calls built-in tools cross-origin
    // (api.papercuspai.com → this host). `cors: true` mounts the
    // shared CORS middleware so the preflight + Authorization
    // header are accepted. Auth itself is the composite bearer resolver
    // wired in E2 (`HOST_EXTRAS.resolvePrincipalAndTx`).
    cors: true,
    handler: dispatchHttp,
  }),
);
