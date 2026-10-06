/**
 * Minimal newline-delimited JSON-RPC 2.0 client/server bridge for the
 * subprocess daemon runtime (Batch I3).
 *
 * Wire format: each message is one JSON object terminated by `\n`. The
 * daemon side reads from stdin / writes to stdout in the same shape;
 * stderr is reserved for free-form logs the supervisor pipes to onLog.
 *
 * Concurrency: outgoing requests are tagged with monotonic ids; replies
 * dispatch to pending promises by id. Server-initiated notifications
 * (no id) fire onNotification for the operator-side bridge to relay
 * as host events (the event-reaction registry).
 */

import type { Readable, Writable } from 'node:stream';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

/**
 * Error a request handler throws to control the JSON-RPC error it replies
 * with. Any other thrown value replies `-32000` with its message.
 */
export class JsonRpcHandlerError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcHandlerError';
  }
}

/** Handles one daemon→host request; its resolved value is the reply `result`. */
export type JsonRpcRequestHandler = (params: unknown) => unknown | Promise<unknown>;

export class JsonRpcBridge {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = '';
  private closed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private notifHandlers: Array<(n: JsonRpcNotification) => void> = [];
  private requestHandlers = new Map<string, JsonRpcRequestHandler>();

  constructor(
    private stdout: Readable,
    private stdin: Writable,
  ) {
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => this.onData(chunk));
    stdout.on('end', () => this.shutdown(new Error('peer stdout closed')));
    stdin.on('error', (e: Error) => this.shutdown(e));
  }

  onNotification(fn: (n: JsonRpcNotification) => void): void {
    this.notifHandlers.push(fn);
  }

  /**
   * Serve a daemon→host request `method`. A request for a method with no
   * handler replies `-32601`, so a daemon can never reach a host capability
   * the host did not deliberately expose.
   */
  onRequest(method: string, handler: JsonRpcRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  async call<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) throw new Error('bridge closed');
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write(req);
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.reject(new Error(`json-rpc call timed out after ${timeoutMs}ms: ${method}`));
        }
      }, timeoutMs);
      // Clear the timer on settle. The `.catch` is load-bearing: this `.finally`
      // forms a SEPARATE promise chain off `promise`, so without it a rejected
      // call (timeout / error reply / shutdown) leaves an UNHANDLED rejection on
      // this floating chain — the caller's own `await promise` already surfaces
      // the real rejection, so swallowing it here is correct.
      void promise.finally(() => clearTimeout(timer)).catch(() => {});
    }
    return (await promise) as T;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const n: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.write(n);
  }

  shutdown(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(err ?? new Error('bridge shut down'));
    this.pending.clear();
  }

  private async serveRequest(req: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(req.method);
    let reply: JsonRpcResponse;
    if (!handler) {
      reply = { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } };
    } else {
      try {
        const result = await handler(req.params);
        reply = { jsonrpc: '2.0', id: req.id, result: result ?? null };
      } catch (e: unknown) {
        reply =
          e instanceof JsonRpcHandlerError
            ? { jsonrpc: '2.0', id: req.id, error: { code: e.code, message: e.message, data: e.data } }
            : { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } };
      }
    }
    if (!this.closed) this.write(reply);
  }

  private write(msg: object): void {
    try {
      this.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch (e: unknown) {
      this.shutdown(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;
      try {
        msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;
      } catch {
        // Garbage on stdout; don't crash the bridge — log via stderr
        // path is supervisor's job.
        continue;
      }
      if (msg === null || typeof msg !== 'object') continue;
      if ('method' in msg && typeof msg.method === 'string' && 'id' in msg && msg.id != null) {
        // A daemon→host REQUEST (both id and method). Before P-002 this
        // shape was mistaken for a reply and silently dropped.
        void this.serveRequest(msg as JsonRpcRequest);
      } else if ('id' in msg && msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) continue; // stale reply
        this.pending.delete(msg.id);
        if ('error' in msg && msg.error) {
          p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        } else {
          p.resolve((msg as JsonRpcResponse).result);
        }
      } else if ('method' in msg) {
        for (const h of this.notifHandlers) {
          try { h(msg as JsonRpcNotification); } catch { /* swallow */ }
        }
      }
    }
  }
}
