/**
 * The route-stack — the dispatch pipeline for `defineTool` endpoints.
 *
 * Mirrors the Phase 3a tool dispatch-stack (`packages/agent-mcp/src/
 * dispatch-stack.ts`): named, ordered steps; a mutable per-call
 * execution object; an orchestrator that runs the steps and records
 * telemetry in `finally`. It does NOT reuse the tool stack's types —
 * `DispatchExecution` is tool-shaped (a `ProjectedTool`, `ctx.emit`, a
 * replay buffer). A route has none of those. So this is a parallel,
 * deliberately smaller stack: 3 steps, no role/quota/replay/streaming.
 *
 *   auth → input → invoke   (telemetry runs in finally)
 *
 * Plan: apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md
 */

import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { ZodTypeAny } from 'zod';
import type { Principal } from '@papercusp/agent-mcp';
import { PrincipalCheckError, requirePrincipal } from '../auth/require-principal';
import { principalFromCookie } from '../auth/principal/from-cookie';
import type { RouteDefinition } from './define-route';
import { defaultCorsOrigin } from './cors';
import { requireLoopbackOr403 } from './loopback-guard';
import { foreignLoopbackPeerResponse } from '../auth/loopback-peer-trust';
import { recordRouteInvocation } from './telemetry';
import { recordHttpTraffic } from '../coverage-census/attribution/sink';
import {
  currentRemoteAuthPolicy,
  isConfiguredRemoteOrigin,
  isDirectRemoteRequest,
  REMOTE_OPERATOR_CAPABILITY,
  requestExternalOrigin,
  requestWorkspaceId,
} from '../remote-auth-policy';

/* ─── Step names ─────────────────────────────────────────────────────── */

export type RouteStepName = 'auth' | 'input' | 'invoke';

const committedResponses = new WeakSet<Response>();

/**
 * Preserve a receipt only AFTER its durable effect has committed. A deadline
 * can request cancellation, but cannot turn a completed mutation into a
 * refusal. The marker is server-local; request/response headers cannot set it.
 * Unmarked responses and handlers that throw retain normal timeout behavior.
 */
export function committedRouteResponse(response: Response): Response {
  committedResponses.add(response);
  return response;
}

/* ─── Per-call mutable state ─────────────────────────────────────────── */

export interface RouteExecution {
  readonly def: RouteDefinition<ZodTypeAny | undefined>;
  /** The Hono context — the route-stack's only Hono coupling. */
  readonly hono: Context;
  /** Web-standard Request, lifted off the Hono context. */
  readonly req: Request;
  /** Socket peer captured by the host adapter; never derived from request headers. */
  readonly peerAddress?: string | null;
  readonly startedAt: number;

  // ── written by 'auth' ──
  principal: Principal | null;
  // ── written by 'input' ──
  input: unknown;
  // ── written by the orchestrator ──
  abort: AbortController;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  /** Terminal status, for telemetry. */
  status: 'ok' | 'unauthorized' | 'forbidden' | 'invalid-input' | 'timeout' | 'error';
  // ── written by the orchestrator's `finally`, before recordRouteInvocation (EI-7069) ──
  /** Response body size in bytes, from the handler Response's Content-Length
   *  header when present. Null for streaming/chunked responses (no header) —
   *  never consumes/clones the body, so this can't break a streaming route. */
  responseBytes: number | null;
}

/* ─── Step contract ──────────────────────────────────────────────────── */

/**
 * A route step. Returns a `Response` to short-circuit (auth denied,
 * bad input, handler result) or `null` to continue. `invoke` is always
 * terminal — it returns the handler's `Response`.
 */
export interface RouteStep {
  name: RouteStepName;
  run(exec: RouteExecution): Promise<Response | null>;
}

/* ─── Error envelope ─────────────────────────────────────────────────── */

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/* ─── Steps ──────────────────────────────────────────────────────────── */

/**
 * The headers `requirePrincipal` resolves against. Normally the request's
 * own headers; when the route's `auth.tokenIn` admits `'query'` and no
 * `Authorization` header is present, the `?token=` query param is lifted
 * into a synthetic `Authorization: Bearer` so the standard bearer
 * resolvers see it unchanged. Opt-in per route — query tokens leak into
 * access logs (see `PrincipalRequirements.tokenIn`).
 */
function authHeaders(exec: RouteExecution): Headers {
  const auth = exec.def.auth;
  if (
    typeof auth === 'object' &&
    auth.tokenIn?.includes('query') &&
    !exec.req.headers.get('authorization')
  ) {
    const qToken = new URL(exec.req.url).searchParams.get('token');
    if (qToken) {
      const h = new Headers(exec.req.headers);
      h.set('authorization', `Bearer ${qToken}`);
      return h;
    }
  }
  return exec.req.headers;
}

/**
 * Loopback-tier enforcement (auth-tier rollout Wave 1, audit D-007/D-009,
 * owner-approved 2026-06-10): `auth: 'loopback'` routes take no principal
 * but reject non-loopback hosts at this chokepoint. Flag-gated so a bad
 * rollout reverts with one flip (OFF = the route behaves as `'public'`,
 * i.e. pre-rollout); requireLoopbackOr403's PAPERCUSP_ALLOW_REMOTE_ADMIN
 * env opt-out stays the deliberate remote-admin lever either way.
 */
async function endpointAuthTiersEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.ENDPOINT_AUTH_TIERS, 'system');
  } catch {
    // Flag layer unreachable — fail CLOSED to the declared tier: a route
    // that says loopback-only stays loopback-only.
    return true;
  }
}

const SAFE_BROWSER_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const LOOPBACK_BROWSER_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '10.0.2.2',
]);

const NATIVE_SHELL_ORIGINS = new Set([
  'tauri://tauri.localhost',
  'tauri://localhost',
  'https://tauri.localhost',
  'http://tauri.localhost',
  'capacitor://localhost',
  'ionic://localhost',
]);

/**
 * Browser origins that are intentionally configured by the local launcher.
 * The old CORS layer accepted every localhost port, which made an unrelated
 * local dev server a credentialed reader of loopback-only GET routes. Keep the
 * established :3055 operator-dev origin, but let a launcher override/add its
 * actual instance through the existing base/origin environment variables.
 */
function configuredLocalBrowserOrigins(): Set<string> {
  const origins = new Set(['http://localhost:3055', 'http://127.0.0.1:3055']);
  for (const key of [
    'PAPERCUSP_OPERATOR_BASE',
    'PAPERCUSP_RELEASE_ORIGIN',
    'OPERATOR_E2E_BASE_URL',
    'OPERATOR_BASE_URL',
  ]) {
    const value = process.env[key]?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        !url.username &&
        !url.password &&
        (url.pathname === '/' || url.pathname === '') &&
        !url.search &&
        !url.hash &&
        LOOPBACK_BROWSER_HOSTS.has(url.hostname)
      ) {
        origins.add(url.origin);
      }
    } catch {
      // A malformed optional launcher hint must not widen the policy.
    }
  }
  return origins;
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

/** Same loopback instance, allowing localhost ↔ 127.0.0.1 sibling sharding. */
function isSameLoopbackInstance(request: URL, origin: URL): boolean {
  if (request.protocol !== origin.protocol) return false;
  if (!LOOPBACK_BROWSER_HOSTS.has(request.hostname) || !LOOPBACK_BROWSER_HOSTS.has(origin.hostname)) {
    return false;
  }
  return effectivePort(request) === effectivePort(origin);
}

function isNativeShellOrigin(origin: string): boolean {
  return NATIVE_SHELL_ORIGINS.has(origin);
}

/**
 * Safe-browser read policy for loopback routes. No Origin remains valid for
 * CLI/native transports. Once a browser supplies an Origin, it must be an
 * explicit route origin, the same loopback instance (including sibling-host
 * sharding), a configured launcher origin, or a known native shell origin.
 */
function enforceBrowserReadPolicy(exec: RouteExecution): Response | null {
  if (!SAFE_BROWSER_METHODS.has(exec.def.method) || exec.def.auth !== 'loopback') return null;

  const rawOrigin = exec.req.headers.get('origin')?.trim() ?? '';
  if (!rawOrigin) return null;
  // Opaque origins are never trusted, even when a caller can reach loopback.
  if (rawOrigin === 'null') {
    return errorResponse(403, 'cross_origin_blocked', 'opaque browser origins are not allowed for loopback reads');
  }

  if (typeof exec.def.cors === 'object' && exec.def.cors.origins.includes(rawOrigin)) return null;
  if (exec.def.cors === false) {
    return errorResponse(403, 'cross_origin_blocked', 'browser Origin is not allowed for this route');
  }
  if (isNativeShellOrigin(rawOrigin) || configuredLocalBrowserOrigins().has(rawOrigin)) return null;

  try {
    const origin = new URL(rawOrigin);
    const request = new URL(exec.req.url);
    if (
      !origin.username &&
      !origin.password &&
      (origin.pathname === '/' || origin.pathname === '') &&
      !origin.search &&
      !origin.hash &&
      isSameLoopbackInstance(request, origin)
    ) {
      return null;
    }
  } catch {
    // Fall through to the common denial below.
  }
  return errorResponse(
    403,
    'cross_origin_blocked',
    'loopback reads require the exact trusted browser origin for this instance',
  );
}

function allowsBrowserOrigin(
  def: RouteDefinition<ZodTypeAny | undefined>,
  origin: string,
): boolean {
  if (typeof def.cors === 'object') return def.cors.origins.includes(origin);
  if (def.cors === false) return false;
  return Boolean(defaultCorsOrigin(origin));
}

/**
 * Cross-origin simple requests bypass CORS preflight when they use a
 * safelisted content type such as `text/plain`. Protect every local
 * mutation at the route-stack choke point instead of relying on individual
 * handlers to remember a CSRF guard.
 *
 * Requests without an Origin remain valid for CLI/native transports. Fetch
 * Metadata closes the browser case where a cross-site request omits Origin;
 * an explicitly trusted route Origin is still admitted even when the
 * browser reports it as cross-site (for example, a paired device).
 */
function enforceBrowserMutationPolicy(exec: RouteExecution): Response | null {
  if (SAFE_BROWSER_METHODS.has(exec.def.method)) return null;

  const origin = exec.req.headers.get('origin')?.trim() ?? '';
  const originTrusted = Boolean(origin) && allowsBrowserOrigin(exec.def, origin);
  if (origin && !originTrusted) {
    return errorResponse(
      403,
      'cross_origin_blocked',
      'browser mutation Origin is not allowed for this route',
    );
  }

  const fetchSite = exec.req.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (fetchSite === 'cross-site' && !originTrusted) {
    return errorResponse(
      403,
      'cross_origin_blocked',
      'cross-site browser mutations require a trusted Origin',
    );
  }
  return null;
}

function remotePeerAddress(hono: Context): string | null {
  try {
    const address = getConnInfo(hono).remote.address;
    return typeof address === 'string' && address.trim() ? address.trim() : null;
  } catch {
    // Hono's in-process app.request() has no Node socket bindings. The remote
    // policy falls back to the request authority in that unit context.
    return null;
  }
}

function isRemoteAuthBootstrap(def: RouteDefinition<ZodTypeAny | undefined>): boolean {
  return (
    (def.method === 'POST' && def.path === '/auth/login') ||
    (def.method === 'GET' && def.path === '/auth/me') ||
    (def.method === 'POST' && def.path === '/auth/logout')
  );
}

/**
 * Native off-loopback authorization choke point. Local and SSH-forwarded
 * requests retain their existing public/loopback compatibility. A direct
 * remote browser must use an exact configured HTTPS authority/origin; every
 * non-bootstrap route additionally needs an explicitly workspace-bound,
 * verified cookie with the dedicated remote-operator capability.
 */
async function enforceRemoteAuth(exec: RouteExecution): Promise<{ remote: boolean; denial: Response | null }> {
  const peer = exec.peerAddress ?? remotePeerAddress(exec.hono);
  if (!isDirectRemoteRequest(exec.req, peer)) return { remote: false, denial: null };

  const policy = currentRemoteAuthPolicy();
  const authority = requestExternalOrigin(exec.req);
  if (!authority || !policy.origins.includes(authority)) {
    return {
      remote: true,
      denial: errorResponse(403, 'remote_authority_denied', 'request authority is not an allowed HTTPS origin'),
    };
  }

  const origin = exec.req.headers.get('origin');
  const originAllowed = Boolean(
    origin &&
    origin === authority &&
    isConfiguredRemoteOrigin(origin),
  );
  if ((origin && !originAllowed) || (!SAFE_BROWSER_METHODS.has(exec.req.method) && !originAllowed)) {
    return {
      remote: true,
      denial: errorResponse(403, 'remote_origin_denied', 'unsafe remote requests require the exact configured Origin'),
    };
  }

  if (isRemoteAuthBootstrap(exec.def)) return { remote: true, denial: null };

  const workspaceId = requestWorkspaceId(exec.req);
  if (!workspaceId) {
    return {
      remote: true,
      denial: errorResponse(400, 'workspace_required', 'remote requests require an explicit workspace'),
    };
  }

  const principal = await principalFromCookie(exec.req.headers);
  if (!principal) {
    return {
      remote: true,
      denial: errorResponse(401, 'unauthorized', 'a verified remote operator session is required'),
    };
  }
  if (
    principal.kind !== 'user' ||
    principal.trust !== 'verified' ||
    !principal.capabilities.has(REMOTE_OPERATOR_CAPABILITY)
  ) {
    return {
      remote: true,
      denial: errorResponse(403, 'remote_capability_denied', `missing capability: ${REMOTE_OPERATOR_CAPABILITY}`),
    };
  }
  if (principal.workspaceId !== workspaceId) {
    return {
      remote: true,
      denial: errorResponse(403, 'workspace_mismatch', 'session workspace does not match the request workspace'),
    };
  }
  exec.principal = principal;
  return { remote: true, denial: null };
}

const authStep: RouteStep = {
  name: 'auth',
  async run(exec) {
    const remote = await enforceRemoteAuth(exec);
    if (remote.denial) {
      exec.status = remote.denial.status === 401 ? 'unauthorized' : 'forbidden';
      return remote.denial;
    }
    // Direct-remote requests have already passed the exact configured
    // authority/Origin policy above. Local requests need the same browser
    // mutation protection so a simple text/plain POST cannot reach input or
    // invoke (WI-2144494).
    if (!remote.remote) {
      const browserMutation = enforceBrowserMutationPolicy(exec);
      if (browserMutation) {
        exec.status = 'forbidden';
        return browserMutation;
      }
      const browserRead = enforceBrowserReadPolicy(exec);
      if (browserRead) {
        exec.status = 'forbidden';
        return browserRead;
      }
    }
    // Direct-remote public/loopback declarations are local compatibility
    // metadata, not authorization. The central verified-cookie gate above is
    // authoritative for them.
    if (remote.remote && !isRemoteAuthBootstrap(exec.def) && (
      exec.def.auth === 'public' || exec.def.auth === 'loopback'
    )) {
      return null;
    }
    if (exec.def.auth === 'public') {
      exec.principal = null;
      return null;
    }
    if (exec.def.auth === 'loopback') {
      exec.principal = null;
      // WI-10003619: independent of the auth-tier rollout flag. With the flag OFF a
      // loopback route degrades to 'public' for a single-user host; on a hosted host
      // that would hand the customer account every loopback route again.
      const foreignPeer = foreignLoopbackPeerResponse();
      if (foreignPeer) {
        exec.status = 'forbidden';
        return foreignPeer;
      }
      if (await endpointAuthTiersEnabled()) {
        const gate = requireLoopbackOr403(exec.req);
        if (gate) {
          exec.status = 'forbidden';
          return gate;
        }
      }
      return null;
    }
    try {
      exec.principal = await requirePrincipal(authHeaders(exec), exec.def.auth);
      return null;
    } catch (err) {
      if (err instanceof PrincipalCheckError) {
        exec.status = err.status === 401 ? 'unauthorized' : 'forbidden';
        return errorResponse(err.status, err.status === 401 ? 'unauthorized' : 'forbidden', err.reason);
      }
      throw err;
    }
  },
};

const inputStep: RouteStep = {
  name: 'input',
  async run(exec) {
    const schema = exec.def.input;
    if (!schema) {
      exec.input = undefined;
      return null;
    }
    // POST/PUT/PATCH read the JSON body; GET/DELETE read the query string.
    let raw: unknown;
    const m = exec.def.method;
    if (m === 'POST' || m === 'PUT' || m === 'PATCH') {
      try {
        raw = await exec.req.clone().json();
      } catch {
        exec.status = 'invalid-input';
        return errorResponse(400, 'invalid_input', 'request body is not valid JSON');
      }
    } else {
      raw = Object.fromEntries(new URL(exec.req.url).searchParams);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      exec.status = 'invalid-input';
      return errorResponse(
        400,
        'invalid_input',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    exec.input = parsed.data;
    return null;
  },
};

const invokeStep: RouteStep = {
  name: 'invoke',
  async run(exec) {
    // `timeoutSec: null` = no watchdog — long-lived SSE/streaming routes
    // whose handler legitimately outlives any fixed budget (EI-110: the 30s
    // default turned healthy streams into 408s).
    const timeoutSec = exec.def.timeoutSec === null ? null : exec.def.timeoutSec ?? 30;
    if (timeoutSec !== null) {
      const timer = setTimeout(() => exec.abort.abort(), timeoutSec * 1000);
      if (typeof timer.unref === 'function') timer.unref();
      exec.timeoutTimer = timer;
    }

    try {
      const result = exec.def.handler(exec.req, {
        principal: exec.principal,
        input: exec.input,
        params: exec.hono.req.param() as Record<string, string>,
        peerAddress: exec.peerAddress ?? null,
        log: (level, msg, meta) => {
          // R1: console. R2 routes this through the telemetry logger.
          const line = `[route ${exec.def.method} ${exec.def.path}] ${msg}`;
          if (level === 'error') console.error(line, meta ?? '');
          else if (level === 'warn') console.warn(line, meta ?? '');
          else console.log(line, meta ?? '');
        },
        signal: exec.abort.signal,
      });
      const response = await Promise.resolve(result);
      // A committed receipt is authoritative even if the watchdog fired while
      // persistence was pending. Never replace it with a false refusal.
      const committed = committedResponses.delete(response);
      if (exec.abort.signal.aborted && !committed) {
        exec.status = 'timeout';
        return errorResponse(408, 'timeout', `route exceeded ${timeoutSec}s`);
      }
      exec.status = 'ok';
      return response;
    } catch (err) {
      if (exec.abort.signal.aborted) {
        exec.status = 'timeout';
        return errorResponse(408, 'timeout', `route exceeded ${timeoutSec}s`);
      }
      exec.status = 'error';
      return errorResponse(
        500,
        'handler_error',
        err instanceof Error ? err.message : String(err),
      );
    }
  },
};

/* ─── Default stack ──────────────────────────────────────────────────── */

/**
 * The route dispatch stack. Order is load-bearing: `auth` before
 * `input` (don't parse a body for a caller we'll reject), `input`
 * before `invoke`. Frozen — production callers don't mutate it.
 */
export const DEFAULT_ROUTE_STACK: ReadonlyArray<RouteStep> = Object.freeze([
  authStep,
  inputStep,
  invokeStep,
]);

/* ─── Orchestrator ───────────────────────────────────────────────────── */

/**
 * Run a route definition through the stack and return the `Response`.
 * Telemetry records in `finally` on every termination path. Never
 * throws — an unexpected error becomes a 500.
 */
export async function runRouteStack(
  def: RouteDefinition<ZodTypeAny | undefined>,
  hono: Context,
  stack: ReadonlyArray<RouteStep> = DEFAULT_ROUTE_STACK,
): Promise<Response> {
  const exec: RouteExecution = {
    def,
    hono,
    req: hono.req.raw,
    peerAddress: remotePeerAddress(hono),
    startedAt: Date.now(),
    principal: null,
    input: undefined,
    abort: new AbortController(),
    timeoutTimer: null,
    status: 'error',
    responseBytes: null,
  };
  // Initialized (never actually surfaced — both try/catch below always
  // overwrite it) purely so TS's definite-assignment analysis considers it
  // safe to read in `finally` (EI-7069 added a `response.headers` read there).
  let response: Response = errorResponse(500, 'handler_error', 'route stack produced no response');
  try {
    let short: Response | null = null;
    for (const step of stack) {
      short = await step.run(exec);
      if (short) break;
    }
    // `invoke` is terminal — the loop always ends with a Response.
    response = short ?? errorResponse(500, 'handler_error', 'route stack produced no response');
  } catch (err) {
    exec.status = 'error';
    response = errorResponse(500, 'handler_error', err instanceof Error ? err.message : String(err));
  } finally {
    if (exec.timeoutTimer) clearTimeout(exec.timeoutTimer);
    // EI-7069: Content-Length only — never .clone()/read the body. A streaming
    // (SSE/chunked) response has no Content-Length, so this stays null for
    // those rather than risk consuming/buffering a stream for telemetry.
    try {
      const len = response.headers.get('content-length');
      const parsed = len ? Number(len) : NaN;
      exec.responseBytes = Number.isFinite(parsed) ? parsed : null;
    } catch {
      exec.responseBytes = null;
    }
    try {
      recordRouteInvocation(exec);
    } catch {
      /* telemetry is best-effort */
    }
    // Coverage-census attribution (plan deterministic-coverage-census-2026-08-17, P-004).
    // Inert unless PAPERCUSP_TEST_ATTRIBUTION=1 — the first statement in the hook is a cached
    // boolean, so a production request pays one branch. It sits HERE, not in a Hono middleware,
    // because `def` IS the census identity: `providers/hono-routes.ts` enumerates
    // `routeRegistrationOrder()`, and `registerRoute` mounts exactly one `runRouteStack` per
    // entry of that same array — so observer and census cannot disagree about what a surface
    // is. A middleware would have to re-derive it from `c.req.routePath`, a second source of
    // truth for the one identity this system may not get wrong.
    try {
      recordHttpTraffic({
        method: def.method,
        path: def.path,
        status: exec.status,
        httpStatus: response.status,
        headers: hono.req.raw.headers,
      });
    } catch {
      /* attribution is best-effort — it must never affect the response it describes */
    }
  }
  return response;
}
