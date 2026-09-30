/**
 * Spawner IPC client — calls the SPAWNER sidecar over a JSON-RPC 2.0 Unix socket
 * (WI-344 ③, plan spawner-sidecar-offload-2026-06-30).
 *
 * Cloned from sync/hyperbee/substrate-ipc-client.ts. When the OFF-by-default
 * SPAWNER_SIDECAR flag is ON, spawnInvokeOnceWithFallback (orchestrator-runner.ts)
 * routes the agent-spawn fork/exec + buildInvokeOnce OFF the bg-host main loop and
 * over this client into the sidecar. Failures fall back to in-process (the sidecar
 * is optional) — same posture as the substrate client.
 *
 * EXTENSION over the substrate client — a server→client PUSH (notification)
 * channel. A message carrying a `method` + `params` and NO top-level `id` is a
 * JSON-RPC NOTIFICATION (not a response). The sidecar pushes two while a
 * `spawn:invokeOnce` is in flight, both carrying the originating request's id in
 * `params.requestId`:
 *   - `spawn:pid`            { requestId, pid }  — the child OS pid right after spawn (EI-85)
 *   - `spawn:outputActivity` { requestId }       — every stdout/stderr chunk (liveness, P-008)
 * The client routes each to per-request callbacks registered at `call()` time
 * (`onPid` / `onOutputActivity`), keyed by the request id — so the in-process
 * caller gets the SAME mid-turn signals it would from a local spawnInvokeOnce.
 */

import * as net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { resolveSpawnerSocketPath } from './spawner-socket-path';

export interface SpawnerRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Per-request push callbacks, registered at call() time, keyed by request id. */
export interface SpawnerCallOpts {
  /** Fired once with the child OS pid (the sidecar's `spawn:pid` notification). */
  onPid?: (pid: number) => void;
  /** Fired on every child stdout/stderr chunk (the `spawn:outputActivity` push). */
  onOutputActivity?: () => void;
  /** Surfaces the assigned request id back to the caller synchronously, BEFORE
   *  the call resolves — so an aborting caller can `call('spawn:cancel',{requestId})`. */
  onRequestId?: (id: number) => void;
  /** Client-side RPC timeout (ms). Default 30_000 for short CONTROL calls. Pass 0 to
   *  DISABLE it for a long-running call: `spawn:invokeOnce` carries the ENTIRE agent
   *  run (minutes) and must NOT be capped by a fixed client timeout — the sidecar's
   *  own spawn timeout (runChild invokeTimeoutMs) is the real bound. A fixed 30s here
   *  spuriously timed out every real spawn → fallback → DOUBLE-spawn (WI-344 ③ bug). */
  timeoutMs?: number;
}

/**
 * Spawner IPC client: sends JSON-RPC 2.0 requests over a Unix socket.
 * Line-based protocol: one JSON-RPC message per line. Correlates responses by id
 * and routes server→client notifications to per-request callbacks.
 */
export class SpawnerIpcClient {
  private socket: net.Socket | null = null;
  private socketPath: string;
  private connected = false;
  private requestId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** Per-request push-notification callbacks, keyed by request id. */
  private callbacks = new Map<number, { onPid?: (pid: number) => void; onOutputActivity?: () => void }>();
  private buffer = '';
  /**
   * Decodes socket chunks across boundaries. The server side got the same
   * treatment for inbound requests; this is the RESPONSE/notification leg —
   * a multi-byte UTF-8 character straddling two `data` events would otherwise
   * decode to replacement chars, and when the damage lands inside a string
   * value the JSON still parses, so the caller silently accepts a wrong
   * stdout/stderr or error text with no error raised anywhere.
   */
  private decoder = new StringDecoder('utf8');
  private connectPromise: Promise<void> | null = null;

  constructor(socketPath?: string) {
    // Absolute, env-pinned path (the spawner sets PAPERCUSP_SPAWNER_IPC_SOCKET
    // before forking, so client + child agree). Never CWD-relative — see P-006.
    this.socketPath = socketPath || resolveSpawnerSocketPath();
  }

  /**
   * Reset ALL per-connection state so the NEXT ensureConnected() dials fresh.
   *
   * WI-2141693 — the load-bearing piece. Before this, a sidecar death (or a
   * failed dial) left `socket` + `connectPromise` populated forever: every
   * later ensureConnected() short-circuited on the ALREADY-SETTLED promise and
   * every call() wrote into a dead socket. Measured 2026-09-02: the sidecar
   * crashed and respawned in 11s, yet bg-host logged 333+ `Cannot call write
   * after a stream was destroyed` fallbacks over the next 99 minutes
   * (pot-git 13,230 / harness-docs 3,423 / git-sync 1,922) and only a restart
   * cleared it. The fallback is functionally correct, so nothing errored — what
   * degraded was latency, back to the ~40ms/GB fork stall the sidecar exists to
   * remove.
   *
   * Guarded by socket IDENTITY so a stale socket's late 'error'/'close' can
   * never clobber a newer re-dialed connection. This is the same fix the
   * sibling substrate client carries (WI-895); this client was cloned from it
   * and never received it.
   */
  private teardown(sock: net.Socket, err: Error): void {
    if (this.socket !== sock) return; // late event from a superseded socket
    this.socket = null;
    this.connected = false;
    this.connectPromise = null;
    // Drop any partial line AND any partial multi-byte sequence: carrying
    // either across a reconnect would prepend garbage to the next connection's
    // first line (same reason close() resets them).
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    // Reject all pending requests + drop their callbacks.
    for (const [id, { reject: rej }] of this.pending) {
      rej(new Error(`Socket error: ${err.message}`));
      this.callbacks.delete(id);
    }
    this.pending.clear();
  }

  /**
   * Ensure connected to the sidecar socket. Re-dials after any error/close —
   * a dead connection never sticks (WI-2141693).
   */
  async ensureConnected(): Promise<void> {
    if (this.connected && this.socket && !this.socket.destroyed) return;

    // A socket that is already destroyed but whose 'close' has not yet been
    // delivered would otherwise fall through to the settled `connectPromise`
    // below and be written into. Retire it now so the dial is deterministic
    // rather than dependent on event ordering.
    if (this.socket?.destroyed) {
      this.teardown(this.socket, new Error(`Sidecar socket destroyed (${this.socketPath})`));
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      // A connect attempt settles exactly once, but 'error' and 'close' can
      // both fire for the same failure; without this the second one would
      // reject an already-resolved promise (a silent no-op that made the real
      // dial error unreportable).
      let settled = false;
      const settleOk = (): void => {
        if (!settled) { settled = true; resolve(); }
      };
      const settleErr = (e: Error): void => {
        if (!settled) { settled = true; reject(e); }
      };

      const sock = net.createConnection(this.socketPath, () => {
        this.connected = true;
        // Keep the persistent connection available for a long-lived host, but
        // do not let it keep a short-lived diagnostic process alive after its
        // last RPC completes. The owner-side shutdown hook still closes it
        // when the host exits.
        sock.unref();
        settleOk();
      });
      this.socket = sock;

      sock.on('data', (chunk: Buffer) => {
        // Ignore a superseded socket's late data — it would be decoded into
        // the CURRENT connection's buffer and desync its frame walk.
        if (this.socket === sock) this.handleData(chunk);
      });

      sock.on('error', (err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        this.teardown(sock, e);
        settleErr(e);
      });

      sock.on('close', () => {
        // Fires on sidecar death AND after error/destroy; teardown is
        // idempotent via the socket-identity guard. After an ESTABLISHED
        // connection closes, settleErr is a no-op (already resolved) — the
        // RESET is what lets the next ensureConnected() re-dial.
        const e = new Error(`Sidecar socket closed (${this.socketPath})`);
        this.teardown(sock, e);
        settleErr(new Error(`Sidecar connection closed before ready (${this.socketPath})`));
      });

      // Connection timeout: 5s (only reachable when the dial neither connects
      // nor errors — e.g. a listener with a saturated accept queue).
      const timeout = setTimeout(() => {
        if (!this.connected && this.socket === sock) {
          const e = new Error(`Connection timeout dialing spawner sidecar at ${this.socketPath}`);
          this.teardown(sock, e);
          settleErr(e);
          sock.destroy();
        }
      }, 5000);
      timeout.unref?.();

      sock.once('connect', () => clearTimeout(timeout));
      sock.once('close', () => clearTimeout(timeout));
    });

    return this.connectPromise;
  }

  /**
   * Send an RPC request and wait for the response. Optional `opts` registers the
   * per-request push callbacks (onPid / onOutputActivity) and surfaces the
   * assigned request id (onRequestId) for cancellation wiring.
   */
  async call<T = unknown>(method: string, params?: unknown, opts?: SpawnerCallOpts): Promise<T> {
    await this.ensureConnected();

    if (!this.socket) {
      throw new Error('Not connected to spawner sidecar');
    }

    const id = ++this.requestId;
    if (opts?.onPid || opts?.onOutputActivity) {
      this.callbacks.set(id, { onPid: opts.onPid, onOutputActivity: opts.onOutputActivity });
    }
    // Hand the id back synchronously so the caller can correlate a later
    // `spawn:cancel` to THIS request before it resolves.
    opts?.onRequestId?.(id);
    const request = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    return new Promise<T>((resolve, reject) => {
      // Request timeout. Default 30s for short control calls; opts.timeoutMs:0
      // DISABLES it for spawn:invokeOnce (the whole agent run, minutes — the
      // sidecar's own spawn timeout bounds it). A fixed 30s here spuriously timed
      // out every real spawn → fallback → double-spawn (WI-344 ③ bug).
      const timeoutMs = opts?.timeoutMs ?? 30000;
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              this.callbacks.delete(id);
              reject(new Error(`RPC request timeout: ${method}`));
            }, timeoutMs)
          : null;
      const clear = (): void => {
        if (timeout) clearTimeout(timeout);
      };

      this.pending.set(id, {
        resolve: (value: unknown) => {
          clear();
          this.callbacks.delete(id);
          resolve(value as T);
        },
        reject: (error: Error) => {
          clear();
          this.callbacks.delete(id);
          reject(error);
        },
      });

      this.socket!.write(JSON.stringify(request) + '\n', (err) => {
        if (err) {
          clear();
          this.pending.delete(id);
          this.callbacks.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Handle incoming data from the socket — one JSON-RPC message per line. A
   * message with a numeric top-level `id` is a RESPONSE (correlated to a pending
   * request); a message with a `method` and NO `id` is a NOTIFICATION (routed to
   * the per-request push callbacks via `params.requestId`).
   */
  private handleData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);

    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) continue;
      let msg: {
        jsonrpc?: string;
        id?: number;
        method?: string;
        params?: { requestId?: number; pid?: number } & Record<string, unknown>;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
      };
      try {
        msg = JSON.parse(line);
      } catch (err) {
        console.warn('[spawner-ipc-client] failed to parse message:', err);
        continue;
      }

      // NOTIFICATION (server→client PUSH): method present, no top-level id.
      if (typeof msg.method === 'string' && msg.id === undefined) {
        const requestId = msg.params?.requestId;
        if (typeof requestId !== 'number') continue;
        const cb = this.callbacks.get(requestId);
        if (!cb) continue;
        if (msg.method === 'spawn:pid' && typeof msg.params?.pid === 'number') {
          try { cb.onPid?.(msg.params.pid); } catch { /* best-effort */ }
        } else if (msg.method === 'spawn:outputActivity') {
          try { cb.onOutputActivity?.(); } catch { /* best-effort */ }
        }
        continue;
      }

      // RESPONSE: correlate by id.
      const id = msg.id;
      if (typeof id !== 'number') continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);

      if (msg.error) {
        pending.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  /**
   * Close the connection.
   */
  close(): void {
    if (this.socket) {
      const socket = this.socket;
      this.teardown(socket, new Error('Connection closed by caller'));
      socket.destroy();
    }
    this.connected = false;
    this.connectPromise = null;
    this.callbacks.clear();
    // Drop any partial line AND any partial multi-byte sequence held by the
    // decoder: this client reconnects, and carrying either across a reconnect
    // would prepend garbage to the first line of the next connection.
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }
}

/**
 * Global IPC client instance (lazy-initialized).
 */
let globalClient: SpawnerIpcClient | null = null;

export function getSpawnerIpcClient(socketPath?: string): SpawnerIpcClient {
  if (!globalClient) {
    globalClient = new SpawnerIpcClient(socketPath);
  }
  return globalClient;
}

/**
 * Close the global client (for graceful shutdown).
 */
export function closeSpawnerIpcClient(): void {
  if (globalClient) {
    globalClient.close();
    globalClient = null;
  }
}
