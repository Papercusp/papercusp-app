import {
  base64ToBytes,
  buildHostedWorkspaceSocketUrl,
  bytesToBase64,
  readHostedWorkspaceTicket,
} from "./hosted-workspace-session-protocol";

export type HostedDesktopViewerMode = "watch" | "takeover";

/**
 * How long one viewer attempt may take to reach `connected` before it is abandoned
 * and retried on a fresh ticket (WI-10004214). Without it a dial that never settled
 * left the stage on "Opening your desktop…" forever, with no error and Reconnect
 * disabled — the owner's first Take control on avi-test, 2026-09-30.
 */
export const HOSTED_DESKTOP_CONNECT_DEADLINE_MS = 15_000;

/** Attempts per connect (initial + automatic retries) before the viewer shows an error. */
export const HOSTED_DESKTOP_CONNECT_ATTEMPTS = 3;

export interface HostedDesktopReadyEvent {
  action: "watch" | "takeover";
  inputAllowed: boolean;
}

export interface HostedDesktopRosterEntry {
  desktopSessionId: string;
  state: string;
  displayNumber?: number;
  geometry?: string;
  lastActiveAt?: string;
  /** P-006 / D-009: who the desktop belongs to and what its owner is on now. */
  scope?: "pot" | "agent" | "workspace";
  owner?: string;
  name?: string;
  workItemId?: string;
  workItemIntent?: string;
}

export interface HostedDesktopThumbnailResult {
  desktopSessionId: string;
  data: string | null;
  bytes?: number;
}

export type HostedDesktopProtocolEvent =
  | {
      kind: "ready";
      action: "watch" | "takeover";
      inputAllowed: boolean;
    }
  | { kind: "data"; data: Uint8Array }
  | { kind: "roster"; requestId: string; desktops: HostedDesktopRosterEntry[] }
  | { kind: "started"; requestId: string; desktop: HostedDesktopRosterEntry }
  | {
      kind: "thumbnail";
      requestId: string;
      desktopSessionId: string;
      data: string | null;
      bytes?: number;
    }
  | { kind: "error"; operation: string; code: string; requestId?: string };

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function roster(value: unknown): HostedDesktopRosterEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = record(candidate);
    const desktopSessionId = nonEmptyString(item?.desktopSessionId);
    const state = nonEmptyString(item?.state);
    if (!desktopSessionId || !state) return [];
    const displayNumber = safeInteger(item?.displayNumber);
    const geometry = nonEmptyString(item?.geometry);
    const lastActiveAt = nonEmptyString(item?.lastActiveAt);
    const scope =
      item?.scope === "pot" || item?.scope === "agent" || item?.scope === "workspace"
        ? item.scope
        : null;
    const owner = nonEmptyString(item?.owner);
    const name = nonEmptyString(item?.name);
    const workItemId = nonEmptyString(item?.workItemId);
    const workItemIntent = nonEmptyString(item?.workItemIntent);
    return [
      {
        desktopSessionId,
        state,
        ...(displayNumber !== null && displayNumber >= 0
          ? { displayNumber }
          : {}),
        ...(geometry ? { geometry } : {}),
        ...(lastActiveAt ? { lastActiveAt } : {}),
        ...(scope ? { scope } : {}),
        ...(owner ? { owner } : {}),
        ...(name ? { name } : {}),
        ...(workItemId ? { workItemId } : {}),
        ...(workItemId && workItemIntent ? { workItemIntent } : {}),
      },
    ];
  });
}

export function buildHostedDesktopSocketUrl(
  origin: string,
  ticket: string,
  desktopSessionId: string,
  mode: HostedDesktopViewerMode,
): string {
  if (!desktopSessionId.trim()) {
    throw new TypeError("desktop_session_required");
  }
  const url = new URL(buildHostedWorkspaceSocketUrl(origin, ticket));
  url.searchParams.set("kind", "desktop");
  url.searchParams.set("desktopSessionId", desktopSessionId);
  url.searchParams.set("desktopMode", mode);
  return url.toString();
}

export function readHostedDesktopTicket(value: unknown): string | null {
  return readHostedWorkspaceTicket(value);
}

export function buildDesktopRosterRequest(requestId: string): string {
  return JSON.stringify({
    type: "desktop.roster",
    requestId,
  });
}

/**
 * Ask the workspace host to start its desktop, or return the running one
 * (D-405). The host answers only on a controller session.
 */
export function buildDesktopStartRequest(requestId: string): string {
  return JSON.stringify({
    type: "desktop.start",
    requestId,
  });
}

export function buildDesktopThumbnailRequest(
  requestId: string,
  desktopSessionId: string,
): string {
  return JSON.stringify({
    type: "desktop.thumbnail",
    requestId,
    desktopSessionId,
  });
}

export function buildDesktopDataRelay(data: Uint8Array): string {
  return JSON.stringify({
    type: "desktop.data",
    data: bytesToBase64(data),
  });
}

export function parseHostedDesktopProtocolMessage(
  value: unknown,
): HostedDesktopProtocolEvent | null {
  const payload = record(value);
  const type = nonEmptyString(payload?.type);
  if (!payload || !type) return null;

  if (type === "desktop.ready") {
    const action =
      payload.action === "takeover"
        ? "takeover"
        : payload.action === "watch"
          ? "watch"
          : null;
    if (!action || typeof payload.inputAllowed !== "boolean") return null;
    return { kind: "ready", action, inputAllowed: payload.inputAllowed };
  }

  if (type === "desktop.data") {
    const data = nonEmptyString(payload.data);
    if (!data) return null;
    try {
      return { kind: "data", data: base64ToBytes(data) };
    } catch {
      return null;
    }
  }

  if (type === "desktop.roster.result") {
    const requestId = nonEmptyString(payload.requestId);
    if (!requestId) return null;
    return { kind: "roster", requestId, desktops: roster(payload.desktops) };
  }

  if (type === "desktop.start.result") {
    const requestId = nonEmptyString(payload.requestId);
    const [desktop] = roster([payload.desktop]);
    if (!requestId || !desktop) return null;
    return { kind: "started", requestId, desktop };
  }

  if (type === "desktop.thumbnail.result") {
    const requestId = nonEmptyString(payload.requestId);
    const desktopSessionId = nonEmptyString(payload.desktopSessionId);
    if (!requestId || !desktopSessionId) return null;
    const data = payload.data === null ? null : nonEmptyString(payload.data);
    if (payload.data !== null && data === null) return null;
    if (data !== null) {
      try {
        // Validate the wire value before it reaches an image data URL. A
        // malformed relay response should stay an explicit protocol miss.
        base64ToBytes(data);
      } catch {
        return null;
      }
    }
    const bytes = safeInteger(payload.bytes);
    return {
      kind: "thumbnail",
      requestId,
      desktopSessionId,
      data,
      ...(bytes !== null && bytes >= 0 ? { bytes } : {}),
    };
  }

  if (type === "operation.error") {
    const operation = nonEmptyString(payload.operation);
    const code = nonEmptyString(payload.code);
    const requestId = nonEmptyString(payload.requestId);
    if (!operation || !code) return null;
    return {
      kind: "error",
      operation,
      code,
      ...(requestId ? { requestId } : {}),
    };
  }

  return null;
}

export interface HostedDesktopRawChannel {
  readonly OPEN: number;
  readonly CLOSED: number;
  readonly CONNECTING: number;
  readonly CLOSING: number;
  binaryType: "arraybuffer";
  protocol: string;
  readyState: number;
  inputAllowed: boolean;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null;
  onopen: (() => void) | null;
  onready: ((event: HostedDesktopReadyEvent) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

interface WebSocketLike {
  readonly OPEN: number;
  readonly CLOSED: number;
  readonly CONNECTING: number;
  readonly CLOSING: number;
  readyState: number;
  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: {
      data?: unknown;
      code?: number;
      reason?: string;
    }) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

function toUint8Array(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * Adapt the JSON/base64 desktop relay into the raw byte channel expected by
 * noVNC. The browser control socket remains a text socket; only after the host
 * authorizes and dials the desktop does this channel announce `onopen` to RFB.
 */
export class HostedDesktopRelayChannel implements HostedDesktopRawChannel {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly CLOSING = 2;
  binaryType = "arraybuffer" as const;
  protocol = "";
  readyState = this.CONNECTING;
  inputAllowed = false;
  onerror: ((event: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  /**
   * WI-10004214: bytes that arrived before noVNC attached. The viewer constructs
   * noVNC after an async import, and on a page's first open the host's version
   * greeting beats that import; dropping it left noVNC waiting in ProtocolVersion.
   */
  private held: ArrayBuffer[] = [];
  private messageHandler: ((event: { data: ArrayBuffer }) => void) | null =
    null;

  get onmessage(): ((event: { data: ArrayBuffer }) => void) | null {
    return this.messageHandler;
  }

  set onmessage(handler: ((event: { data: ArrayBuffer }) => void) | null) {
    this.messageHandler = handler;
    if (!handler || this.held.length === 0) return;
    // noVNC assigns onmessage inside attach(), BEFORE _socketOpen() starts the
    // handshake, so bytes delivered synchronously here would be unparseable.
    queueMicrotask(() => this.deliverHeld());
  }

  private deliverHeld(): void {
    while (this.held.length > 0 && this.messageHandler) {
      if (this.readyState !== this.OPEN) {
        this.held = [];
        return;
      }
      this.messageHandler({ data: this.held.shift()! });
    }
  }
  onready: ((event: HostedDesktopReadyEvent) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(private readonly socket: WebSocketLike) {
    socket.addEventListener("message", (event) => {
      if (this.readyState === this.CLOSED) return;
      if (typeof event.data !== "string") return;
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = parseHostedDesktopProtocolMessage(value);
      if (!parsed) return;
      if (parsed.kind === "ready") {
        if (this.readyState !== this.CONNECTING) return;
        this.inputAllowed = parsed.inputAllowed;
        this.readyState = this.OPEN;
        this.onready?.(parsed);
        // `onready` may deliberately fail closed (for example when the relay
        // reports a different action than the ticket requested) and close the
        // channel synchronously. Never hand an already-closing channel to
        // noVNC's onopen callback in that case.
        if (this.readyState !== this.OPEN) return;
        this.onopen?.();
      } else if (parsed.kind === "data") {
        if (this.readyState !== this.OPEN) return;
        const data = toArrayBuffer(parsed.data);
        // Behind anything still held, so the stream keeps its order.
        if (this.messageHandler && this.held.length === 0) {
          this.messageHandler({ data });
        } else {
          this.held.push(data);
        }
      } else if (parsed.kind === "error") {
        this.onerror?.(parsed);
      }
    });
    socket.addEventListener("error", (event) => {
      if (this.readyState === this.CLOSED) return;
      this.onerror?.(event);
    });
    socket.addEventListener("close", (event) => {
      if (this.readyState === this.CLOSED) return;
      this.readyState = this.CLOSED;
      this.inputAllowed = false;
      this.held = [];
      this.onclose?.(event);
    });
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (
      this.readyState !== this.OPEN ||
      this.socket.readyState !== this.socket.OPEN
    ) {
      return;
    }
    this.socket.send(buildDesktopDataRelay(toUint8Array(data)));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSING;
    this.socket.close(code, reason);
  }
}
