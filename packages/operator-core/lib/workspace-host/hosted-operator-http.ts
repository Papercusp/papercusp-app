/**
 * The `operator-http` relay plane (D-418, WI-10002873): the cloud portal's chat and
 * session traffic, carried over the outbound workspace connector to THIS machine's
 * own loopback operator.
 *
 * ## Why the forward is to loopback, and what that makes this file
 *
 * The workspace host runs inside the customer's operator process, so the request is
 * forwarded to `127.0.0.1:<own port>`. The operator's `auth:'loopback'` routes then
 * see a loopback caller — which means THIS FILE is the authorization boundary for
 * everything the relay reaches. Three rules follow, each pinned by a test:
 *
 *  1. DEFAULT-DENY ROUTES. Only the (method, path) pairs in
 *     {@link OPERATOR_HTTP_ROUTE_ALLOWLIST} are forwarded: the chat, conversation,
 *     session-launch, sync-read and Add-a-pot surfaces the portal renders. Everything else —
 *     every other loopback admin surface (D-025) — answers 403 without a request.
 *  2. NO CALLER-SUPPLIED CREDENTIAL OR IDENTITY. Only a small header allowlist is
 *     forwarded (content type, accept, SSE resume). `authorization`, `cookie`,
 *     `host`, forwarding headers and our own principal headers are dropped, so a
 *     caller can neither present a bearer nor claim a different user.
 *  3. THE PRINCIPAL COMES FROM THE CHANNEL. The ticket's user and hosted session —
 *     bound at `relay.open` by the control plane from a single-use workspace-operator
 *     ticket — are stamped on every forwarded request, and every request is audited
 *     under that user.
 *
 * ## Wire
 *
 * client→host  `http.request { requestId, method, path, headers?, body? (base64) }`
 *              `http.abort   { requestId }`
 * host→client  `http.response { requestId, status, headers }`
 *              `http.body     { requestId, data (base64) }`   (≤ 48 KiB each)
 *              `http.end      { requestId }`
 *              `http.error    { requestId, code }`
 *
 * A request body travels whole in `http.request`, bounded by
 * {@link HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES} so the frame stays under the
 * relay's 1 MiB message cap. Chat and launch bodies are a few KiB; a larger body is
 * refused with `request_body_too_large` rather than truncated.
 */

export const HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES = 512 * 1024;
export const HOSTED_OPERATOR_HTTP_BODY_CHUNK_BYTES = 48 * 1024;
/** Concurrent requests per channel. A browser tab's sync client holds a handful of SSE streams. */
export const HOSTED_OPERATOR_HTTP_MAX_INFLIGHT = 32;
/**
 * Response-header budget. A turn STREAMS for minutes; this bounds only the wait for headers.
 * Not applied to a route marked `awaitsRouteBudget` — see {@link OperatorHttpRoute}.
 */
export const HOSTED_OPERATOR_HTTP_HEADER_TIMEOUT_MS = 30_000;

/**
 * Headers a portal request may carry to the operator. Everything else is dropped.
 * Not `x-papercusp-workspace`: the portal's workspace id is the CONTROL PLANE's
 * customer-workspace id, not this operator's own, and this operator serves exactly
 * one workspace — its own pin is the only right scope here.
 */
const FORWARDED_REQUEST_HEADERS = new Set(['content-type', 'accept', 'last-event-id']);
/** Headers relayed back. Never `set-cookie`: the relay has no cookie jar to give it to. */
const RELAYED_RESPONSE_HEADERS = new Set(['content-type', 'cache-control', 'x-accel-buffering', 'retry-after']);

export const HOSTED_PRINCIPAL_USER_HEADER = 'x-papercusp-hosted-user-id';
export const HOSTED_PRINCIPAL_SESSION_HEADER = 'x-papercusp-hosted-session-id';

const SEG = '[^/?#]+';

export interface OperatorHttpRoute {
  method: string;
  pattern: RegExp;
  surface: string;
  /**
   * The relay does not cut this route's wait for headers at
   * {@link HOSTED_OPERATOR_HTTP_HEADER_TIMEOUT_MS}. For a slow WRITE — a pot create,
   * a clone, an install — that cut reports a failure for a create the operator then
   * finishes (WI-10003268). The bound is the operator route's own watchdog, which
   * answers 408 at its `timeoutSec` (route-stack.ts). Set it only on a route that
   * HAS a finite `timeoutSec`; the allowlist test pins that.
   */
  awaitsRouteBudget?: true;
}

/**
 * The ONLY routes the relay forwards. Default-deny: add a route here, with the
 * portal surface that needs it, or it answers 403 `route_not_relayed`.
 */
export const OPERATOR_HTTP_ROUTE_ALLOWLIST: ReadonlyArray<OperatorHttpRoute> = [
  // Sync transport behind useSyncQuery (chat lists, session rosters).
  { method: 'GET', pattern: /^\/api\/zero-harness\/rest-query$/, surface: 'sync read' },
  { method: 'GET', pattern: /^\/api\/zero-harness\/sse$/, surface: 'sync stream' },
  // "Ask Papercup" agent chats (portal agent-chats.ts).
  { method: 'GET', pattern: new RegExp(`^/api/harness/${SEG}/agent-chats$`), surface: 'agent chats list' },
  { method: 'POST', pattern: new RegExp(`^/api/harness/${SEG}/agent-chats$`), surface: 'agent chat create' },
  { method: 'GET', pattern: new RegExp(`^/api/harness/${SEG}/agent-chats/${SEG}$`), surface: 'agent chat read' },
  { method: 'POST', pattern: new RegExp(`^/api/harness/${SEG}/agent-chats/${SEG}/messages$`), surface: 'agent chat turn' },
  // Papercup chat (portal papercup-chat.ts).
  { method: 'GET', pattern: /^\/api\/operator\/conversations$/, surface: 'conversations list' },
  { method: 'POST', pattern: /^\/api\/operator\/conversations$/, surface: 'conversation create' },
  { method: 'GET', pattern: new RegExp(`^/api/operator/conversations/${SEG}/turns$`), surface: 'conversation turns' },
  { method: 'POST', pattern: new RegExp(`^/api/operator/conversations/${SEG}/turns$`), surface: 'conversation turn' },
  { method: 'POST', pattern: new RegExp(`^/api/operator/conversations/${SEG}/card-response$`), surface: 'card response' },
  { method: 'POST', pattern: new RegExp(`^/api/operator/conversations/${SEG}/turn-answer$`), surface: 'turn answer' },
  { method: 'POST', pattern: /^\/api\/agent-mcp\/operator-converse$/, surface: 'operator converse' },
  { method: 'GET', pattern: /^\/api\/agent-config$/, surface: 'agent settings read' },
  { method: 'POST', pattern: /^\/api\/agent-config$/, surface: 'agent settings save' },
  // Sessions (portal agent-sessions.ts PORTAL_SESSION_ROUTES + history) and "new session".
  { method: 'GET', pattern: /^\/api\/adv\/session\/thinking$/, surface: 'session transcript stream' },
  { method: 'POST', pattern: /^\/api\/admin\/coordination\/sessions\/list$/, surface: 'sessions list' },
  { method: 'POST', pattern: /^\/api\/admin\/coord\/send$/, surface: 'session message' },
  { method: 'GET', pattern: /^\/api\/adv\/sessions\/ended$/, surface: 'ended sessions' },
  { method: 'GET', pattern: /^\/api\/adv\/sessions\/search-transcripts$/, surface: 'transcript search' },
  { method: 'POST', pattern: /^\/api\/adv\/sessions\/launch-su$/, surface: 'new session' },
  { method: 'GET', pattern: /^\/api\/agent-mcp\/console\/bootstrap-su\/options$/, surface: 'new session options' },
  // The Add-a-pot popup (CreateHarnessPicker and the forms it opens, WI-10003268):
  // a hosted user's pots live on THEIR workspace machine, so it is the one to create them.
  { method: 'POST', pattern: /^\/api\/harness\/projects$/, surface: 'pot create (folder / repo)', awaitsRouteBudget: true },
  { method: 'POST', pattern: /^\/api\/harness\/pots$/, surface: 'pot create', awaitsRouteBudget: true },
  { method: 'POST', pattern: /^\/api\/harness\/pots\/from-repo$/, surface: 'pot create from GitHub', awaitsRouteBudget: true },
  { method: 'POST', pattern: /^\/api\/harness\/join-link$/, surface: 'pot join link', awaitsRouteBudget: true },
  { method: 'POST', pattern: /^\/api\/discovery\/join-pot$/, surface: 'pot join', awaitsRouteBudget: true },
  { method: 'POST', pattern: /^\/api\/discovery\/join-invite$/, surface: 'pot invite join', awaitsRouteBudget: true },
  { method: 'GET', pattern: /^\/api\/github\/search-repos$/, surface: 'GitHub repo search' },
  { method: 'GET', pattern: /^\/api\/cupboard\/listings$/, surface: 'Cupboard search' },
  { method: 'GET', pattern: /^\/api\/cupboard\/bindings$/, surface: 'Cupboard repo bindings' },
  { method: 'POST', pattern: /^\/api\/cupboard\/install-blueprint$/, surface: 'Cupboard install', awaitsRouteBudget: true },
  { method: 'GET', pattern: /^\/api\/discovery\/pot-meta$/, surface: 'pot share status' },
  { method: 'POST', pattern: /^\/api\/discovery\/set-pot$/, surface: 'pot publish', awaitsRouteBudget: true },
  // Which popup entries show (POT_FROM_GITHUB_URL among them) — the machine's own flags.
  { method: 'GET', pattern: /^\/api\/flags\/bootstrap$/, surface: 'feature flags' },
];

export type OperatorHttpRouteDecision =
  | { ok: true; method: string; path: string; surface: string; awaitsRouteBudget: boolean }
  | { ok: false; code: 'invalid_path' | 'route_not_relayed' };

/**
 * Decide one request. `path` must be origin-relative (`/api/...`, optional query);
 * anything that could change the authority — a scheme, `//`, a backslash, a dot
 * segment, an encoded slash — is refused before matching, so a path can never
 * resolve to a different route than the one the allowlist approved.
 */
export function decideOperatorHttpRoute(method: unknown, path: unknown): OperatorHttpRouteDecision {
  if (typeof method !== 'string' || typeof path !== 'string' || path.length > 4096) {
    return { ok: false, code: 'invalid_path' };
  }
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\s#]/.test(path)) return { ok: false, code: 'invalid_path' };
  const query = path.indexOf('?');
  const pathname = query === -1 ? path : path.slice(0, query);
  if (/%2f|%5c|%2e/i.test(pathname) || pathname.split('/').some((segment) => segment === '.' || segment === '..')) {
    return { ok: false, code: 'invalid_path' };
  }
  const upper = method.toUpperCase();
  const route = OPERATOR_HTTP_ROUTE_ALLOWLIST.find((entry) => entry.method === upper && entry.pattern.test(pathname));
  return route
    ? { ok: true, method: upper, path, surface: route.surface, awaitsRouteBudget: route.awaitsRouteBudget === true }
    : { ok: false, code: 'route_not_relayed' };
}

/** Filter caller headers to the forwardable set and stamp the channel's principal. */
export function operatorHttpRequestHeaders(
  input: unknown,
  principal: { userId: string; hostedSessionId: string },
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
      const key = name.toLowerCase();
      if (FORWARDED_REQUEST_HEADERS.has(key) && typeof value === 'string' && value.length <= 1024 && !/[\r\n]/.test(value)) {
        headers[key] = value;
      }
    }
  }
  headers[HOSTED_PRINCIPAL_USER_HEADER] = principal.userId;
  headers[HOSTED_PRINCIPAL_SESSION_HEADER] = principal.hostedSessionId;
  return headers;
}

/**
 * This operator's own loopback origin. Same resolution the bootstrap uses for the
 * port it listens on (`PAPERCUSP_HONO_PORT ?? PORT ?? 3070`), always `127.0.0.1`:
 * the relay must never be pointed at another machine.
 */
export function localOperatorOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PAPERCUSP_HONO_PORT?.trim() || env.PORT?.trim() || '3070';
  const port = Number(raw);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 3070}`;
}

export type OperatorHttpSend = (payload: Record<string, unknown>) => void;
export type OperatorHttpAudit = (action: string, detail: string) => void;
export type OperatorHttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OperatorHttpChannelOptions {
  principal: { userId: string; hostedSessionId: string };
  send: OperatorHttpSend;
  audit: OperatorHttpAudit;
  origin?: string;
  fetch?: OperatorHttpFetch;
  headerTimeoutMs?: number;
}

/** One `operator-http` channel's in-flight requests. */
export class OperatorHttpChannel {
  private readonly inflight = new Map<string, AbortController>();
  private readonly origin: string;
  private readonly fetchImpl: OperatorHttpFetch;
  private readonly headerTimeoutMs: number;
  private closed = false;

  constructor(private readonly options: OperatorHttpChannelOptions) {
    this.origin = options.origin ?? localOperatorOrigin();
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.headerTimeoutMs = options.headerTimeoutMs ?? HOSTED_OPERATOR_HTTP_HEADER_TIMEOUT_MS;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  /** Handle one client frame. Resolves when a request's response has fully streamed. */
  async accept(type: string, payload: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    const requestId = typeof payload.requestId === 'string' && payload.requestId.length <= 128 ? payload.requestId : null;
    if (!requestId) return;
    if (type === 'http.abort') {
      // Forget it BEFORE aborting: the request's catch reads absence as "the
      // client asked", which needs no reply — versus a header timeout, which does.
      const controller = this.inflight.get(requestId);
      this.inflight.delete(requestId);
      controller?.abort();
      return;
    }
    if (type !== 'http.request') {
      this.options.send({ type: 'http.error', requestId, code: 'unsupported_frame' });
      return;
    }
    await this.request(requestId, payload);
  }

  close(): void {
    this.closed = true;
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }

  private async request(requestId: string, payload: Record<string, unknown>): Promise<void> {
    const fail = (code: string, status?: number) => {
      this.options.send({ type: 'http.error', requestId, code, ...(status ? { status } : {}) });
    };
    if (this.inflight.has(requestId)) return fail('request_id_in_use');
    if (this.inflight.size >= HOSTED_OPERATOR_HTTP_MAX_INFLIGHT) return fail('too_many_requests', 429);

    const decision = decideOperatorHttpRoute(payload.method, payload.path);
    if (!decision.ok) {
      this.options.audit('operator_http_denied', `${String(payload.method).slice(0, 8)} ${String(payload.path).slice(0, 200)} ${decision.code}`);
      return fail(decision.code, decision.code === 'route_not_relayed' ? 403 : 400);
    }

    let body: Buffer | undefined;
    if (payload.body !== undefined) {
      if (decision.method === 'GET' || typeof payload.body !== 'string') return fail('invalid_body', 400);
      body = Buffer.from(payload.body, 'base64');
      if (body.byteLength > HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES) return fail('request_body_too_large', 413);
    }

    const controller = new AbortController();
    this.inflight.set(requestId, controller);
    const timer = decision.awaitsRouteBudget ? undefined : setTimeout(() => controller.abort(), this.headerTimeoutMs);
    timer?.unref?.();
    const logLine = `${decision.method} ${decision.path.split('?')[0]}`;
    let headersSent = false;
    try {
      const response = await this.fetchImpl(`${this.origin}${decision.path}`, {
        method: decision.method,
        headers: operatorHttpRequestHeaders(payload.headers, this.options.principal),
        ...(body ? { body: new Uint8Array(body) } : {}),
        redirect: 'manual',
        signal: controller.signal,
      });
      clearTimeout(timer);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (RELAYED_RESPONSE_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
      });
      this.options.send({ type: 'http.response', requestId, status: response.status, headers });
      headersSent = true;
      this.options.audit('operator_http_request', `${logLine} ${response.status}`);
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (let offset = 0; offset < value.byteLength; offset += HOSTED_OPERATOR_HTTP_BODY_CHUNK_BYTES) {
            const chunk = value.subarray(offset, Math.min(value.byteLength, offset + HOSTED_OPERATOR_HTTP_BODY_CHUNK_BYTES));
            this.options.send({ type: 'http.body', requestId, data: Buffer.from(chunk).toString('base64') });
          }
        }
      }
      this.options.send({ type: 'http.end', requestId });
    } catch {
      clearTimeout(timer);
      // An abort the CLIENT asked for needs no reply; the client already forgot it.
      if (this.closed || !this.inflight.has(requestId)) return;
      if (controller.signal.aborted && !headersSent) fail('operator_timeout', 504);
      else if (controller.signal.aborted) return;
      else fail(headersSent ? 'operator_stream_failed' : 'operator_unreachable', 502);
    } finally {
      clearTimeout(timer);
      if (this.inflight.get(requestId) === controller) this.inflight.delete(requestId);
    }
  }
}
