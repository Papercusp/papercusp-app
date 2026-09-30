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

export class JsonRpcBridge {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = '';
  private closed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private notifHandlers: Array<(n: JsonRpcNotification) => void> = [];

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
      let msg: JsonRpcResponse | JsonRpcNotification;
      try {
        msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
      } catch {
        // Garbage on stdout; don't crash the bridge — log via stderr
        // path is supervisor's job.
        continue;
      }
      if ('id' in msg && msg.id != null) {
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
