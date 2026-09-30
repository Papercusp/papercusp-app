/**
 * Inbound-HTTP handler deadline for the operator Hono host
 * (infra-fail-fast-build-integrity-2026-06-19 P-006 / B2, lane su-404d4ebc).
 *
 * THE SILENT HANG: a non-MCP API handler that wedges (a stuck PG query, a
 * deadlocked advisory lock, a native addon that never returns — the B1 mem0 hang
 * class) leaves the client hanging FOREVER. Node's own `server.requestTimeout`
 * bounds how long the *request body* may take to arrive, NOT how long a handler
 * runs, so it does not cover this (the "safe half" in hono-host.ts is marginal).
 * This middleware bounds the time a handler may take to PRODUCE its Response and,
 * past the deadline, fast-503s the client with a legible error + Retry-After —
 * converting an infinite hang into a bounded, retryable failure.
 *
 * WHY RACING next() IS STREAMING-SAFE: `await next()` resolves when the downstream
 * handler RETURNS its Response object (headers ready) — not when the body finishes
 * streaming. A well-behaved SSE/streaming handler returns its Response promptly
 * (a lazy/pull body via @papercusp/sse's sseResponse), so `next()` resolves fast
 * and the deadline never fires; the long-lived body streams unbothered. The
 * deadline only bites a handler that never produces a Response — exactly the wedge.
 * On top of that natural safety we EXPLICITLY exclude MCP (legitimately long tool
 * calls + its own ~55s transport cap), every SSE/stream endpoint, WebSocket
 * upgrades, and health/liveness — belt-and-suspenders for any handler that does
 * heavy setup BEFORE returning its streaming Response.
 *
 * CONSERVATIVE BY DESIGN (mirrors the host-backpressure sibling, P-018):
 *  - Default OFF (PAPERCUSP_HTTP_HANDLER_DEADLINE unset/0 → one env read + pass
 *    through). Opt-in kill-switch; the enable is the "coordinate before landing"
 *    attended live-verify this item calls for.
 *  - CANNOT cancel the wedged handler (JS has no preemption — that is B3/P-007's
 *    worker-isolation job). It frees the CLIENT, not the leaked work; the leaked
 *    `next()` is awaited with a rejection handler so a LATE handler error (after
 *    we already 503'd) is swallowed, never an unhandledRejection that exits the host.
 *  - Returns a standalone Response (does not touch `c`), so the leaked handler
 *    mutating the context later can't corrupt the response we already sent.
 */
import type { MiddlewareHandler } from 'hono';

/**
 * Explicit Node http.Server inbound timeouts.
 *
 * TWO jobs:
 *  1. The "safe half" (P-006/B2) — `requestTimeout` / `headersTimeout` bound how
 *     long the request BODY / HEADERS may take to arrive (a slow-loris ceiling).
 *     MARGINAL on Node 25, so these stay OPT-IN (applied only when their env knob
 *     is set) and NEITHER bounds handler runtime (that is the middleware above).
 *  2. The keep-alive-race FIX (WI-1711) — `keepAliveTimeout` is DEFAULT-ON.
 *     Node's default is 5s: the server closes an idle keep-alive socket after 5s,
 *     but an interactive MCP client routinely reuses a pooled socket >5s later
 *     (its between-tool-call think/compose gap), racing the server's FIN →
 *     ECONNRESET, surfaced client-side as "Streamable HTTP error: Error POSTing to
 *     endpoint" with NO server log. The documented fix is to make the SERVER's
 *     keep-alive LONGER than any client/proxy idle-reuse window so the CLIENT
 *     always initiates the close (no race). We default it to 61s. Node requires
 *     `headersTimeout > keepAliveTimeout`, so when we raise keep-alive we also lift
 *     headersTimeout above it (an explicit lower headersTimeout wins and clamps
 *     keep-alive back under it instead). Kill-switch:
 *     PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS=0 restores Node's 5s default.
 *
 * Node treats 0 as "disabled", so `>= 0` is honored. Returns what it applied (for
 * the boot log + tests). `server` is structurally an http.Server.
 */
export interface ServerTimeoutTarget {
  requestTimeout: number;
  headersTimeout: number;
  keepAliveTimeout: number;
}
/** Default server keep-alive (ms): comfortably ABOVE any client/proxy idle-reuse
 *  window so the client, never the server, closes an idle socket first. */
export const DEFAULT_KEEPALIVE_TIMEOUT_MS = 61_000;
/** headersTimeout must exceed keepAliveTimeout; keep this margin above it. */
export const HEADERS_OVER_KEEPALIVE_MARGIN_MS = 4_000;

export function applyServerTimeouts(
  server: ServerTimeoutTarget,
  env: NodeJS.ProcessEnv = process.env,
): { requestTimeout?: number; headersTimeout?: number; keepAliveTimeout?: number } {
  const applied: { requestTimeout?: number; headersTimeout?: number; keepAliveTimeout?: number } = {};

  // requestTimeout — OPT-IN (unchanged; unset ⇒ Node default).
  const req = Number(env.PAPERCUSP_HTTP_REQUEST_TIMEOUT_MS);
  if (env.PAPERCUSP_HTTP_REQUEST_TIMEOUT_MS != null && Number.isFinite(req) && req >= 0) {
    server.requestTimeout = req;
    applied.requestTimeout = req;
  }

  // keepAliveTimeout — DEFAULT-ON (env override; 0 restores Node's 5s default).
  const kaRaw = env.PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS;
  const kaParsed = Number(kaRaw);
  let keepAlive =
    kaRaw != null && Number.isFinite(kaParsed) && kaParsed >= 0 ? kaParsed : DEFAULT_KEEPALIVE_TIMEOUT_MS;

  // headersTimeout — explicit env wins; else, when keep-alive is on, derive it to
  // sit just above keep-alive (Node requires headersTimeout > keepAliveTimeout).
  const headersRaw = env.PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS;
  const headersParsed = Number(headersRaw);
  const headersExplicit = headersRaw != null && Number.isFinite(headersParsed) && headersParsed >= 0;
  let headers: number | undefined = headersExplicit ? headersParsed : undefined;

  if (keepAlive > 0) {
    if (headers != null && headers > 0 && keepAlive >= headers) {
      // An explicit (lower) headers ceiling wins — clamp keep-alive under it so the
      // invariant holds while still far above Node's racy 5s default.
      keepAlive = Math.max(1_000, headers - HEADERS_OVER_KEEPALIVE_MARGIN_MS);
    } else if (headers == null) {
      // Derive headers above the keep-alive we're about to set.
      headers = keepAlive + HEADERS_OVER_KEEPALIVE_MARGIN_MS;
    }
    server.keepAliveTimeout = keepAlive;
    applied.keepAliveTimeout = keepAlive;
  }

  if (headers != null) {
    server.headersTimeout = headers;
    applied.headersTimeout = headers;
  }
  return applied;
}

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_RETRY_AFTER_SEC = 5;

/** Never deadline these prefixes — liveness/health must always answer (and the
 *  deep probe carries its OWN bounded deadline, B4/P-008). */
const PROTECTED_PREFIXES = ['/api/health'];
/** MCP is request-scoped long work (tool calls) + streaming under its own
 *  transport cap; never subject it to the generic handler deadline. */
const MCP_PREFIX = '/api/mcp';
/** Streaming endpoints whose path is the signal (an EventSource sends
 *  `Accept: text/event-stream`, caught separately; these cover non-EventSource
 *  openers + defense-in-depth). Matched against the pathname. */
const STREAM_PATH_PATTERNS: RegExp[] = [
  /\/sse$/, //                 …/coord/inbox/sse, /zero-harness/sse, /api/*/sse
  /\/stream$/, //              /api/flags/stream
  /-stream$/, //               /api/harness/:slug/clobber-stream
  /\/state-snapshot$/, //      /api/operator/state-snapshot
  /\/frame-view$/, //          /api/deploy/:slug/frame-view
];

export interface DeadlineExclusionInput {
  /** Request pathname (URL.pathname). */
  path: string;
  /** Accept header value (null if absent). */
  accept: string | null;
  /** Upgrade header value (null if absent) — WebSocket upgrades stream. */
  upgrade: string | null;
}

/**
 * Pure exclusion decision — unit-testable without a server. A request is exempt
 * from the handler deadline when it is MCP, a health/liveness path, a WebSocket
 * upgrade, an SSE client (`Accept: text/event-stream`), or a known streaming path.
 */
export function isDeadlineExcluded(input: DeadlineExclusionInput): boolean {
  const { path } = input;
  const accept = (input.accept ?? '').toLowerCase();
  const upgrade = (input.upgrade ?? '').toLowerCase();
  if (upgrade.includes('websocket')) return true;
  if (path.startsWith(MCP_PREFIX)) return true;
  if (PROTECTED_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (accept.includes('text/event-stream')) return true;
  if (STREAM_PATH_PATTERNS.some((re) => re.test(path))) return true;
  return false;
}

export function requestDeadlineEnabled(): boolean {
  const v = process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE;
  return v === '1' || v === 'true';
}

/** The handler deadline (ms). Env-tunable; evaluated per call so tests/ops can
 *  flip it without a restart. Generous (well under MCP's ~55–60s transport cap)
 *  so a valid-but-slow query is not killed, tight enough to bound a true wedge. */
export function requestDeadlineMs(): number {
  const raw = Number(process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEADLINE_MS;
}

function retryAfterSec(): number {
  const raw = Number(process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE_RETRY_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETRY_AFTER_SEC;
}

/** Standalone 503 — built without touching `c`, so the leaked (still-running)
 *  handler cannot corrupt the response we already returned. */
export function deadlineTimeoutResponse(deadlineMs: number, retrySec: number): Response {
  return new Response(
    JSON.stringify({
      error: 'handler_timeout',
      message: `request handler exceeded the ${deadlineMs}ms deadline; the operator may be saturated or a dependency wedged — retry shortly`,
      deadlineMs,
      retryAfterSec: retrySec,
    }),
    {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(retrySec),
      },
    },
  );
}

/**
 * Hono middleware: bound a non-streaming handler's time-to-Response. Inert (one
 * env read + passthrough) unless enabled; excluded requests pass straight through.
 * On deadline, returns a 503 and lets the leaked handler settle harmlessly.
 */
export const requestDeadlineMiddleware: MiddlewareHandler = async (c, next) => {
  if (!requestDeadlineEnabled()) return next();
  if (
    isDeadlineExcluded({
      path: new URL(c.req.url).pathname,
      accept: c.req.header('accept') ?? null,
      upgrade: c.req.header('upgrade') ?? null,
    })
  ) {
    return next();
  }

  const ms = requestDeadlineMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve('timeout');
    }, ms);
    // Don't keep the process alive on this timer (and a fired+cleared timer is a no-op).
    timer.unref?.();
  });

  // Attach BOTH handlers so a handler rejection never escapes as an
  // unhandledRejection: if it rejects AFTER we already 503'd, swallow it; if it
  // rejects BEFORE the deadline, re-throw so Hono's normal error path handles it.
  const run: Promise<'done'> = next().then(
    () => {
      clearTimeout(timer);
      return 'done' as const;
    },
    (err) => {
      clearTimeout(timer);
      if (timedOut) return 'done' as const; // already responded 503 — drop the late error
      throw err; // pre-deadline failure — let Hono handle it normally
    },
  );

  const winner = await Promise.race([run, deadline]);
  if (winner === 'timeout') {
    return deadlineTimeoutResponse(ms, retryAfterSec());
  }
  // Handler finished within the deadline; its Response is already on `c.res`.
  return;
};
