/**
 * Framework-neutral HTTP handler factories for the sync server half.
 *
 * Each factory returns a `(req: Request) => Promise<Response>` using only
 * Web-standard Request/Response. The host mounts
 * them under whatever router it uses (the operator wraps each in a
 * `defineTool({ method, path, auth, handler })`). The named-query resolver
 * and the SSE primitives are INJECTED, so this module pulls in no domain
 * or transport dependency.
 *
 * Wire contract:
 *   GET  rest-query?name=&args=<json>      → { rows, version } | { error }
 *   GET  sse                               → text/event-stream (invalidate|update|heartbeat)
 *
 * The former `POST rest-query-batch` route was removed after the client batcher
 * was deleted on 2026-07-26 (drop-sync-batcher-2026-07-25). The library's own
 * transport issues ONE `GET rest-query` per query through a bounded concurrency
 * gate; no host in this repository mounted the former batch route.
 *
 * 🚫 Do NOT "revive" batching here, and do NOT add streaming (NDJSON /
 * chunked-frame) results to it. That exact design was worked out in detail and
 * REJECTED — see drop-sync-batcher-2026-07-25 **D-001**: it reimplements, worse,
 * what individual requests do natively, and a bundle is indivisible so it cannot
 * restore per-query `AbortSignal` cancellation. MEASURED at the 6-connection cap
 * (the one regime batching could pay in): bundle of 95 = 2676 ms vs 95 individual
 * = 1126 ms wall / p50 9.4 ms — individual wins 2.4x. Over desktop IPC, 106
 * queries cost 2922 ms individual vs 3000 ms bundled, with ~7.6x better
 * time-to-first-paint. Reopening requires NEW measurements (D-001; re-refuted as
 * no-http-anywhere-2026-07-28 D-069, which dropped P-018 for proposing exactly
 * this).
 */

import { NAME_NOT_FOUND, type NamedQueryResolver } from './query-registry';
import type { SyncEvent } from './invalidation-bus';
import type { SyncServerTiming } from '../observability/metrics';

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Send the body as-is. NO COMPRESSION — deliberate, do not re-add.
 *
 * This transport's shipping deployment is a local sidecar reached over
 * loopback, where there is no bandwidth to trade CPU for: gzip costs real
 * milliseconds on BOTH ends to shrink bytes that never leave the machine.
 * (The previous async-gzip here existed only to keep `gzipSync` off the
 * event loop — i.e. to hide the cost of work that did not need doing.)
 *
 * A host that genuinely serves this over a network should compress at its
 * edge proxy, which is where content-encoding belongs.
 */
function bodyResponse(_req: Request, body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** GET rest-query?name=&args=<json> — single named query. */
export function createRestQueryHandler(
  resolve: NamedQueryResolver,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    const name = u.searchParams.get('name');
    if (!name) return jsonResponse({ error: 'missing name' }, 400);
    let args: unknown;
    try {
      args = JSON.parse(u.searchParams.get('args') ?? '{}');
    } catch {
      return jsonResponse({ error: 'invalid args (not JSON)' }, 400);
    }
    if (req.signal.aborted) return new Response(null, { status: 499 });
    const resolverStartedAtMs = Date.now();
    try {
      const rows = await resolve(name, args);
      if (rows === NAME_NOT_FOUND) {
        return jsonResponse({ error: `unknown queryName: ${name}`, name }, 400);
      }
      if (req.signal.aborted) return new Response(null, { status: 499 });
      const resolverCompletedAtMs = Date.now();
      const timing: SyncServerTiming = {
        unit: 'ms',
        resolverStartedAtMs,
        resolverCompletedAtMs,
        resolverMs: Math.max(0, resolverCompletedAtMs - resolverStartedAtMs),
      };
      return bodyResponse(req, JSON.stringify({ rows, version: String(Date.now()), timing }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: msg, name }, 500);
    }
  };
}

/**
 * SSE primitives injected from the host's `@papercusp/sse` (kept out of
 * this module so the lib's own tests don't need it linked).
 */
export interface SsePrimitives {
  parseLastEventId: (req: Request) => number | null;
  sseResponse: (opts: {
    signal: AbortSignal;
    lastEventId: number | null;
    heartbeatMs?: number;
    initialHeartbeat?: boolean;
    replay?: () => Array<{ name: string; data: unknown; id: number }>;
    setup: (sink: {
      closed: boolean;
      event: (name: string, data: unknown, meta?: { id?: number }) => void;
      onClose: (fn: () => void) => void;
    }) => void | Promise<void>;
  }) => Response;
}

function payloadFor(ev: SyncEvent): {
  name: string;
  args?: unknown;
  data?: unknown[];
  tsMs: number;
} {
  const out: { name: string; args?: unknown; data?: unknown[]; tsMs: number } = {
    name: ev.name,
    tsMs: ev.ts,
  };
  if (ev.args !== undefined) out.args = ev.args;
  if (ev.data !== undefined) out.data = ev.data;
  return out;
}

/** GET sse — text/event-stream of invalidate|update events + heartbeat. */
export function createSseHandler(
  bus: {
    subscribe(send: (e: SyncEvent) => void): Promise<{ close: () => void }>;
    backfillSince(lastEventId: number): SyncEvent[];
  },
  sse: SsePrimitives,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const lastEventId = sse.parseLastEventId(req);
    return sse.sseResponse({
      signal: req.signal,
      lastEventId,
      heartbeatMs: 10_000,
      initialHeartbeat: true,
      replay: () => {
        if (lastEventId == null || lastEventId <= 0) return [];
        return bus.backfillSince(lastEventId).map((ev) => ({
          name: ev.data !== undefined ? 'update' : 'invalidate',
          data: payloadFor(ev),
          id: ev.id,
        }));
      },
      setup: async (sink) => {
        const handle = await bus.subscribe((ev) => {
          if (sink.closed) return;
          sink.event(ev.data !== undefined ? 'update' : 'invalidate', payloadFor(ev), {
            id: ev.id,
          });
        });
        sink.onClose(handle.close);
      },
    });
  };
}
