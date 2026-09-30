/**
 * Substrate IPC client — calls the sidecar over JSON-RPC 2.0 Unix socket.
 *
 * When SUBSTRATE_SIDECAR flag is ON, bootAllHarnessesForActiveWorkspace
 * uses this client instead of in-process bootHarnessSubstrate calls.
 * Failures fall back to in-process (the sidecar is optional).
 */

import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { resolveSubstrateSocketPath } from './substrate-socket-path';

export interface SubstrateRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface SubstrateRpcResponse<T> {
  ok: boolean;
  result?: T;
  error?: SubstrateRpcError;
}

/**
 * Substrate IPC client: sends JSON-RPC 2.0 requests over Unix socket.
 * Line-based protocol: one JSON-RPC 2.0 per line.
 */
export class SubstrateIpcClient {
  private socket: net.Socket | null = null;
  private socketPath: string;
  private connected = false;
  private requestId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private buffer = '';
  /**
   * Decodes socket chunks across boundaries. A plain per-chunk `toString()`
   * turns a multi-byte UTF-8 character straddling two `data` events into
   * replacement chars — on THIS path that corrupts replicated substrate
   * content or a key, and if the damage lands inside a string value the JSON
   * still parses, so it surfaces as an unreproducible federation divergence
   * rather than an error. Recreated whenever the socket is torn down, so a
   * partial sequence never leaks into the next connection.
   */
  private decoder = new StringDecoder('utf8');
  private connectPromise: Promise<void> | null = null;

  constructor(socketPath?: string) {
    // Absolute, env-pinned path (the spawner sets PAPERCUSP_SUBSTRATE_IPC_SOCKET
    // before forking, so client + child agree). Never CWD-relative — see P-006.
    this.socketPath = socketPath || resolveSubstrateSocketPath();
  }

  /**
   * Reset ALL per-connection state so the NEXT ensureConnected() dials fresh.
   *
   * WI-895 fix (b) — the load-bearing piece. Before this, a sidecar death (or a
   * failed dial) left `socket` + `connectPromise` populated forever: every later
   * ensureConnected() returned the stale settled promise and every call() wrote
   * into a destroyed socket → per-call 30s timeouts against a live replacement
   * sidecar, until the whole operator restarted (live repro: WI-895 post 49995,
   * dev:service_health phantom "sidecar DOWN" 2026-07-03).
   *
   * Guarded by socket identity so a STALE socket's late 'error'/'close' events can
   * never clobber a newer re-dialed connection.
   */
  private teardown(sock: net.Socket, err: Error): void {
    if (this.socket !== sock) return; // late event from a superseded socket
    this.socket = null;
    this.connected = false;
    this.connectPromise = null;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    for (const [, { reject }] of this.pending) {
      reject(new Error(`Socket error: ${err.message}`));
    }
    this.pending.clear();
  }

  /**
   * Ensure connected to the sidecar socket. Re-dials after any error/close —
   * a dead connection never sticks (WI-895 bug #2).
   */
  async ensureConnected(): Promise<void> {
    if (this.connected && this.socket && !this.socket.destroyed) return;

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleOk = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const settleErr = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      const sock = net.createConnection(this.socketPath, () => {
        this.connected = true;
        settleOk();
      });
      this.socket = sock;

      sock.on('data', (chunk: Buffer) => {
        if (this.socket === sock) this.handleData(chunk);
      });

      sock.on('error', (err) => {
        // Surface the REAL dial error (ENOENT/ECONNREFUSED/...). Before WI-895 this
        // reject branch was dead code (`!this.connectPromise` is always false once
        // the async event fires), so an instant ENOENT surfaced 5s later as a
        // misleading generic 'Connection timeout'.
        const e = err instanceof Error ? err : new Error(String(err));
        this.teardown(sock, e);
        settleErr(e);
      });

      sock.on('close', () => {
        // Fires on sidecar death AND after error/destroy; teardown is idempotent
        // via the socket-identity guard. After an ESTABLISHED connection closes,
        // settleErr is a no-op (promise already resolved) — the reset alone is
        // what lets the next ensureConnected() re-dial.
        const e = new Error(`Sidecar socket closed (${this.socketPath})`);
        this.teardown(sock, e);
        settleErr(new Error(`Sidecar connection closed before ready (${this.socketPath})`));
      });

      // Connection timeout: 5s (only reachable when the dial neither connects nor
      // errors — e.g. a listener with a saturated accept queue).
      const timeout = setTimeout(() => {
        if (!this.connected && this.socket === sock) {
          const e = new Error(`Connection timeout dialing substrate sidecar at ${this.socketPath}`);
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
   * Send an RPC request and wait for the response.
   */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.ensureConnected();

    if (!this.socket) {
      throw new Error('Not connected to substrate sidecar');
    }

    const id = ++this.requestId;
    const request = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      this.socket!.write(JSON.stringify(request) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });

      // Request timeout: 30s
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC request timeout: ${method}`));
      }, 30000);

      const originalResolve = resolve;
      const originalReject = reject;
      this.pending.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timeout);
          originalResolve(value as T);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          originalReject(error);
        },
      });
    });
  }

  /**
   * Handle incoming data from the socket.
   */
  private handleData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);

    // Process complete lines (one JSON-RPC per line)
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const response = JSON.parse(line) as {
            jsonrpc?: string;
            id?: number;
            result?: unknown;
            error?: { code: number; message: string; data?: unknown };
          };

          const id = response.id;
          if (typeof id !== 'number') continue;

          const pending = this.pending.get(id);
          if (!pending) continue;

          this.pending.delete(id);

          if (response.error) {
            pending.reject(
              new Error(`RPC error ${response.error.code}: ${response.error.message}`),
            );
          } else {
            pending.resolve(response.result);
          }
        } catch (err) {
          console.warn('[substrate-ipc-client] failed to parse response:', err);
        }
      }
    }
  }

  /**
   * Close the connection (deliberate shutdown — also rejects any in-flight RPCs
   * so nothing hangs to its 30s timeout).
   */
  close(): void {
    const sock = this.socket;
    this.socket = null;
    this.connected = false;
    this.connectPromise = null;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    for (const [, { reject }] of this.pending) {
      reject(new Error('Substrate IPC client closed'));
    }
    this.pending.clear();
    if (sock) sock.destroy();
  }
}

/**
 * Global IPC client instance (lazy-initialized).
 */
let globalClient: SubstrateIpcClient | null = null;

export function getSubstrateIpcClient(socketPath?: string): SubstrateIpcClient {
  if (!globalClient) {
    globalClient = new SubstrateIpcClient(socketPath);
  }
  return globalClient;
}

/**
 * Close the global client (for graceful shutdown).
 */
export function closeSubstrateIpcClient(): void {
  if (globalClient) {
    globalClient.close();
    globalClient = null;
  }
}
