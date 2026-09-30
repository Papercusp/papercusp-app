/**
 * Node/Express bridge for `sseResponse()`.
 *
 * `sseResponse()` returns a Web `Response` (the Web-standard contract used by
 * Next.js / Hono / Workers). Server frameworks built on Node's http layer
 * (NestJS, Express) instead hand you a Node `ServerResponse` to write into.
 * This helper bridges the two so the *server* transport is shared, not just the
 * wire format + client.
 *
 * Deps-free on purpose: it pumps the Web `ReadableStream` body with the
 * Web-standard reader API and writes to a minimal structural response surface —
 * no `node:stream` import, so the package stays dependency-free and Web-first.
 */

import { unrefTimer } from './unref';

/**
 * The slice of a Node `http.ServerResponse` this bridge needs. Express's `res`
 * (which extends `ServerResponse`) satisfies it structurally.
 */
export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  write(chunk: Uint8Array): boolean;
  end(): void;
  /** Optional: used to tear the socket down on a mid-stream read error. */
  destroy?(err?: Error): void;
  /** Optional (Node ServerResponse has it): await 'drain' for backpressure, and
   *  'close'/'error' so a dead client never wedges the pump. P2-4. */
  once?(event: 'drain' | 'close' | 'error', cb: () => void): void;
  /** Optional liveness flags — stop pumping once the socket is torn down. */
  destroyed?: boolean;
  writableEnded?: boolean;
}

/**
 * Copy a Web `Response` (from `sseResponse()`) onto a Node/Express response:
 * status + headers (+ any `extraHeaders`), then stream the body. Returns
 * immediately — the body is pumped in the background, matching the
 * `Readable.fromWeb(res.body).pipe(res)` pattern callers hand-rolled before.
 *
 * @example
 *   const webRes = sseResponse<MyEvents>({ ... });
 *   sseResponseToNode(webRes, res, { 'X-Turn-Id': turnId });
 */
export function sseResponseToNode(
  webRes: Response,
  res: NodeResponseLike,
  extraHeaders?: Record<string, string>,
): void {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => res.setHeader(key, value));
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  }
  const body = webRes.body;
  if (!body) {
    res.end();
    return;
  }
  void pumpWebBodyToNode(body, res);
}

async function pumpWebBodyToNode(
  body: ReadableStream<Uint8Array>,
  res: NodeResponseLike,
): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        // P2-4 (operator-scalability-event-loop-2026-06-16): honor TCP
        // backpressure. `res.write()` returns false when the kernel/socket send
        // buffer is full; if we kept reading + writing regardless, a slow (or
        // hung) client would make Node buffer every SSE frame in heap —
        // unbounded memory growth on the serving host under many slow readers.
        // So when write() signals congestion, PAUSE the source until 'drain'
        // (or the socket closes), back-propagating backpressure to the producer.
        const ok = res.write(value);
        if (ok === false && typeof res.once === 'function') {
          await waitForDrain(res);
        }
      }
      // Socket torn down mid-stream (client gone / errored) — stop pumping.
      if (res.destroyed || res.writableEnded) break;
    }
    if (!res.writableEnded) res.end();
  } catch (err) {
    if (res.destroy) res.destroy(err instanceof Error ? err : new Error(String(err)));
    else res.end();
  } finally {
    // If we bailed before the source drained, tell it to stop producing so its
    // own cleanup (heartbeat timer, etc.) runs. No-op after normal completion.
    void reader.cancel().catch(() => {});
  }
}

/**
 * Resolve when the Node response can accept more writes ('drain'), or when the
 * socket closes/errors (so a dead client never wedges the pump). A generous
 * unref'd timeout is the final backstop against a connection that fires neither.
 */
function waitForDrain(res: NodeResponseLike): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 30_000);
    unrefTimer(timer);
    res.once?.('drain', done);
    res.once?.('close', done);
    res.once?.('error', done);
  });
}
