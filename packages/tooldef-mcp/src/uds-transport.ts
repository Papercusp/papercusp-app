/** Direct MCP JSON-RPC over node:net. No stdio process or HTTP intermediary. */
import { Socket } from "node:net";
import {
  deserializeMessage,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";

export type UdsMcpTransportOptions = (
  | { path: string; socket?: never }
  | { socket: Socket; path?: never }
) & {
  maxFrameBytes?: number;
  maxQueuedBytes?: number;
  maxPendingRequests?: number;
  connectTimeoutMs?: number;
  frameTimeoutMs?: number;
  sendTimeoutMs?: number;
};

export class UdsMcpTransportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UdsMcpTransportError";
  }
}

function positive(value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1)
    throw new RangeError("UDS limits must be positive safe integers");
  return n;
}

// The projected production catalog is already larger than 1 MiB. Keep enough
// bounded headroom for tools/list while the queue cap still limits concurrent
// writes on one authenticated local connection.
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const INITIAL_FRAME_BUFFER_BYTES = 8 * 1024;

/** One connection, owned by the SDK. Reconnection and mutation replay are never automatic. */
export class UdsMcpTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onerror?: Transport["onerror"];
  onclose?: Transport["onclose"];
  private socket?: Socket;
  private started = false;
  private closed = false;
  private buffer?: Buffer;
  private used = 0;
  private frameTimer?: ReturnType<typeof setTimeout>;
  private queuedBytes = 0;
  private readonly incoming = new Set<RequestId>();
  private readonly outgoing = new Set<RequestId>();
  private readonly sends = new Set<(error: Error) => void>();
  private readonly maxFrameBytes: number;
  private readonly maxQueuedBytes: number;
  private readonly maxPendingRequests: number;
  private readonly connectTimeoutMs: number;
  private readonly frameTimeoutMs: number;
  private readonly sendTimeoutMs: number;

  constructor(private readonly options: UdsMcpTransportOptions) {
    this.maxFrameBytes = positive(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES);
    this.maxQueuedBytes = positive(options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES);
    this.maxPendingRequests = positive(options.maxPendingRequests, 64);
    this.connectTimeoutMs = positive(options.connectTimeoutMs, 5_000);
    this.frameTimeoutMs = positive(options.frameTimeoutMs, 10_000);
    this.sendTimeoutMs = positive(options.sendTimeoutMs, 30_000);
    if (options.socket) {
      this.attach(options.socket);
      options.socket.pause();
    } else if (!options.path || !options.path.startsWith("/")) {
      throw new TypeError("UDS client requires an absolute socket path");
    }
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    socket.on("error", (error) => this.fail(error));
    socket.once("close", () => this.finishClose());
    socket.once("end", () => {
      if (this.used)
        this.fail(
          new UdsMcpTransportError(
            "uds_truncated_frame",
            "Peer closed during an MCP frame",
          ),
        );
      else void this.close();
    });
  }

  async start(): Promise<void> {
    if (this.started || this.closed)
      throw new UdsMcpTransportError(
        "uds_lifecycle",
        "Transport already started or closed",
      );
    this.started = true;
    const needsConnect = !this.socket;
    const connectionSocket = this.socket ?? new Socket();
    if (needsConnect) this.attach(connectionSocket);
    if (needsConnect || connectionSocket.connecting) {
      const socket = connectionSocket;
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          socket.off("connect", connected);
          socket.off("error", failed);
          socket.off("close", disconnected);
          error ? reject(error) : resolve();
        };
        const connected = () => finish();
        const failed = (error: Error) => finish(error);
        const disconnected = () =>
          finish(
            new UdsMcpTransportError("uds_closed", "Closed before connecting"),
          );
        const timer = setTimeout(() => {
          const error = new UdsMcpTransportError(
            "uds_connect_timeout",
            "UDS connection timed out",
          );
          finish(error);
          this.fail(error);
        }, this.connectTimeoutMs);
        timer.unref();
        socket
          .once("connect", connected)
          .once("error", failed)
          .once("close", disconnected);
        if (needsConnect) socket.connect(this.options.path!);
      });
    }
    const socket = this.socket;
    if (this.closed || !socket || socket.destroyed)
      throw new UdsMcpTransportError("uds_closed", "Socket is closed");
    socket.on("data", this.read);
    socket.resume();
  }

  private readonly read = (chunk: Buffer): void => {
    try {
      for (let offset = 0; offset < chunk.length && !this.closed; ) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const size = end - offset;
        if (this.used + size > this.maxFrameBytes) {
          throw new UdsMcpTransportError(
            "uds_frame_limit",
            "MCP input frame exceeds maxFrameBytes",
          );
        }
        const required = this.used + size;
        if (!this.buffer || this.buffer.length < required) {
          const capacity = Math.min(
            this.maxFrameBytes,
            Math.max(
              required,
              Math.min(
                this.maxFrameBytes,
                Math.max(INITIAL_FRAME_BUFFER_BYTES, this.buffer?.length ?? 0) * 2,
              ),
            ),
          );
          const next = Buffer.allocUnsafe(capacity);
          if (this.buffer && this.used) this.buffer.copy(next, 0, 0, this.used);
          this.buffer = next;
        }
        chunk.copy(this.buffer, this.used, offset, end);
        this.used += size;
        offset = end + 1;
        if (newline < 0) {
          this.frameTimer ??= setTimeout(
            () =>
              this.fail(
                new UdsMcpTransportError(
                  "uds_frame_timeout",
                  "Incomplete MCP frame timed out",
                ),
              ),
            this.frameTimeoutMs,
          );
          this.frameTimer.unref();
          break;
        }
        clearTimeout(this.frameTimer);
        this.frameTimer = undefined;
        const line = new TextDecoder("utf-8", { fatal: true }).decode(
          this.buffer.subarray(0, this.used),
        );
        this.used = 0;
        let message: JSONRPCMessage;
        try {
          message = deserializeMessage(line.replace(/\r$/, ""));
        } catch {
          // JSON.parse error messages can contain credential-bearing input.
          throw new UdsMcpTransportError(
            "uds_invalid_frame",
            "Invalid MCP JSON-RPC frame",
          );
        }
        if ("method" in message && "id" in message) {
          if (
            this.incoming.has(message.id) ||
            this.incoming.size >= this.maxPendingRequests
          ) {
            throw new UdsMcpTransportError(
              "uds_request_limit",
              "Duplicate or excessive pending MCP requests",
            );
          }
          this.incoming.add(message.id);
        } else if ("id" in message && message.id !== undefined) this.outgoing.delete(message.id);
        if (
          "method" in message &&
          message.method === "notifications/cancelled"
        ) {
          this.incoming.delete(message.params?.requestId as RequestId);
        }
        this.onmessage?.(message);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  async send(message: JSONRPCMessage): Promise<void> {
    const socket = this.socket;
    if (
      !this.started ||
      this.closed ||
      !socket ||
      socket.destroyed ||
      socket.connecting
    ) {
      throw new UdsMcpTransportError(
        "uds_closed",
        "MCP connection unavailable; nothing was sent",
      );
    }
    const frame = serializeMessage(message);
    const bytes = Buffer.byteLength(frame);
    if (
      bytes - 1 > this.maxFrameBytes ||
      this.queuedBytes + bytes > this.maxQueuedBytes
    ) {
      throw new UdsMcpTransportError(
        "uds_output_limit",
        "MCP output admission refused; nothing was sent",
      );
    }
    const requestId =
      "method" in message && "id" in message ? message.id : undefined;
    if (requestId !== undefined) {
      if (
        this.outgoing.has(requestId) ||
        this.outgoing.size >= this.maxPendingRequests
      ) {
        throw new UdsMcpTransportError(
          "uds_request_limit",
          "MCP request admission refused; nothing was sent",
        );
      }
      this.outgoing.add(requestId);
    }
    this.queuedBytes += bytes;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let written = false;
      let drained = false;
      const finish = (error?: Error) => {
        if (settled || (!error && (!written || !drained))) return;
        settled = true;
        clearTimeout(timer);
        socket.off("drain", onDrain);
        this.sends.delete(rejectSend);
        this.queuedBytes -= bytes;
        if (error) {
          if (requestId !== undefined) this.outgoing.delete(requestId);
          reject(error);
        } else {
          if ("id" in message && message.id !== undefined && !("method" in message))
            this.incoming.delete(message.id);
          if (
            "method" in message &&
            message.method === "notifications/cancelled"
          )
            this.outgoing.delete(message.params?.requestId as RequestId);
          resolve();
        }
      };
      const rejectSend = (error: Error) => finish(error);
      const onDrain = () => {
        drained = true;
        finish();
      };
      const timer = setTimeout(
        () =>
          this.fail(
            new UdsMcpTransportError(
              "uds_send_timeout",
              "MCP send timed out; delivery outcome unknown",
            ),
          ),
        this.sendTimeoutMs,
      );
      timer.unref();
      this.sends.add(rejectSend);
      try {
        drained = socket.write(frame, (error) => {
          written = true;
          finish(error ?? undefined);
        });
        if (!drained) socket.once("drain", onDrain);
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    try {
      this.onerror?.(error);
    } finally {
      void this.close();
    }
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.frameTimer);
    this.buffer = undefined;
    this.used = 0;
    this.socket?.off("data", this.read);
    this.incoming.clear();
    this.outgoing.clear();
    const error = new UdsMcpTransportError(
      "uds_closed",
      "MCP connection closed; pending delivery outcomes unknown; requests were not replayed",
    );
    for (const reject of [...this.sends]) reject(error);
    this.onclose?.();
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.finishClose();
  }
}
