export const HOSTED_WORKSPACE_SESSION_PROTOCOL =
  "papercusp-hosted-workspace.v1";

export type HostedWorkspaceTabRole = "controller" | "observer";
export type HostedWorkspaceSessionStatus =
  | "idle"
  | "ticketing"
  | "connecting"
  | "live"
  | "closed"
  | "error";

export interface HostedWorkspaceConnectorConfig {
  routeLabel: string;
  transport: "websocket";
}

export interface HostedWorkspaceFileEntry {
  name: string;
  kind: "file" | "directory";
  bytes?: number;
}

export type HostedWorkspaceFileOperation =
  | "list"
  | "read"
  | "download"
  | "write"
  | "upload";

/**
 * Largest RAW file this client will place in ONE `file.upload` frame.
 *
 * This is a hard CLIENT-SIDE guard, not a limit we can afford to discover from
 * the server's reply, because the relay does not reply: a browser frame over
 * `HOSTED_WORKSPACE_MAX_MESSAGE_BYTES` (1 MiB) is answered by CLOSING the
 * socket with `invalid_browser_message`, which drops the user's terminal along
 * with the upload. base64 inflates 4/3 and the JSON envelope costs a few
 * hundred bytes, so 700 KiB raw encodes to ~933 KiB and keeps ~115 KiB of
 * headroom under the cap.
 *
 * Kept honest by `hosted-workspace-session-protocol.test.ts`, which imports the
 * relay's own cap and fails if this stops fitting inside it.
 */
export const HOSTED_WORKSPACE_MAX_WHOLE_FILE_BYTES = 700 * 1024;

/** Human-readable size for an upload refusal the user has to act on. */
export function formatUploadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the host says it can accept for an upload. See the `ready` event. */
export interface HostedWorkspaceUploadLimits {
  /** Largest complete file the host will store. */
  maxFileBytes: number;
  /** Largest RAW (pre-base64) byte count per chunk frame. */
  maxUploadChunkBytes: number;
}

export type HostedWorkspaceProtocolEvent =
  | {
      kind: "bound";
      channelId: string;
      role: HostedWorkspaceTabRole;
      generation: number;
      hostedSessionId: string;
    }
  | {
      kind: "role";
      role: HostedWorkspaceTabRole;
      reason?: string;
    }
  | {
      kind: "ready";
      role: HostedWorkspaceTabRole;
      resumed: boolean;
      /**
       * Upload capability advertised by the host, ABSENT on a host that
       * predates chunked upload.
       *
       * Absence is load-bearing, not a default to fill in: hosts run pinned
       * generations in customer VMs, and sending a chunk sequence to one that
       * cannot assemble it writes each chunk as a whole file, leaving only the
       * last on disk. No `limits` therefore means "whole-file only", never
       * "assume the current limits".
       */
      limits?: HostedWorkspaceUploadLimits;
    }
  | {
      kind: "upload-progress";
      requestId: string;
      uploadId: string;
      received: number;
      chunks: number;
      count: number;
    }
  | { kind: "terminal-data"; source: "output" | "snapshot"; data: Uint8Array }
  | { kind: "exit"; code: number; signal: number }
  | { kind: "denied"; reason: string; requestType?: string }
  | {
      kind: "file-result";
      requestId: string;
      operation: HostedWorkspaceFileOperation;
      entries?: HostedWorkspaceFileEntry[];
      path?: string;
      bytes?: number;
      data?: string;
      encoding?: "base64" | "utf8";
    }
  | {
      kind: "operation-error";
      operation: string;
      code: string;
      requestId?: string;
    };

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

function role(value: unknown): HostedWorkspaceTabRole | null {
  return value === "controller" || value === "observer" ? value : null;
}

function fileOperation(value: unknown): HostedWorkspaceFileOperation | null {
  return value === "list" ||
    value === "read" ||
    value === "download" ||
    value === "write" ||
    value === "upload"
    ? value
    : null;
}

function fileEntries(value: unknown): HostedWorkspaceFileEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: HostedWorkspaceFileEntry[] = [];
  for (const candidate of value) {
    const entry = record(candidate);
    const name = nonEmptyString(entry?.name);
    const kind = entry?.kind;
    if (!name || (kind !== "file" && kind !== "directory")) continue;
    const bytes = safeInteger(entry?.bytes);
    entries.push({
      name,
      kind,
      ...(bytes !== null && bytes >= 0 ? { bytes } : {}),
    });
  }
  return entries;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)),
    );
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  // Empty base64 is the canonical encoding for a valid zero-byte file.
  if (value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new TypeError("invalid_base64");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new TypeError("invalid_base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

export function base64ToUtf8(value: string): string {
  return new TextDecoder().decode(base64ToBytes(value));
}

export function buildHostedWorkspaceSocketUrl(
  origin: string,
  ticket: string,
): string {
  if (!/^ht_[A-Za-z0-9_-]{43}$/.test(ticket)) {
    throw new TypeError("invalid_hosted_workspace_ticket");
  }
  const url = new URL("/api/hosted/connectors/socket", origin);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new TypeError("unsupported_hosted_workspace_origin");
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

export function readHostedWorkspaceId(value: unknown): string | null {
  const payload = record(value);
  if (payload?.ok !== true) return null;
  return nonEmptyString(record(payload.session)?.workspaceId);
}

export function readHostedWorkspaceTicket(value: unknown): string | null {
  const payload = record(value);
  if (payload?.ok !== true) return null;
  const ticket = nonEmptyString(payload.ticket);
  return ticket && /^ht_[A-Za-z0-9_-]{43}$/.test(ticket) ? ticket : null;
}

/**
 * The control projection already carries provider-neutral tunnel state. The
 * credential-lifecycle lane may publish its D-143 connector binding either as
 * `tunnel.hostedConnector`, `tunnel.connector`, or the tunnel object itself;
 * this reader accepts only the one transport the browser session supports.
 */
export function readHostedWorkspaceConnector(
  value: unknown,
): HostedWorkspaceConnectorConfig | null {
  const root = record(value);
  if (!root) return null;
  const candidate =
    record(root.hostedConnector) ?? record(root.connector) ?? root;
  const routeLabel = nonEmptyString(candidate.routeLabel);
  if (!routeLabel || candidate.transport !== "websocket") return null;
  return { routeLabel, transport: "websocket" };
}

export function parseHostedWorkspaceProtocolMessage(
  value: unknown,
): HostedWorkspaceProtocolEvent | null {
  const payload = record(value);
  const type = nonEmptyString(payload?.type);
  if (!payload || !type) return null;

  if (type === "session.bound") {
    if (payload.protocol !== HOSTED_WORKSPACE_SESSION_PROTOCOL) return null;
    const binding = record(payload.binding);
    const channelId = nonEmptyString(payload.channelId);
    const tabRole = role(payload.role);
    const generation = safeInteger(binding?.generation);
    const hostedSessionId = nonEmptyString(binding?.hostedSessionId);
    if (!channelId || !tabRole || generation === null || !hostedSessionId) {
      return null;
    }
    return {
      kind: "bound",
      channelId,
      role: tabRole,
      generation,
      hostedSessionId,
    };
  }

  if (type === "session.role") {
    const tabRole = role(payload.role);
    if (!tabRole) return null;
    const reason = nonEmptyString(payload.reason);
    return { kind: "role", role: tabRole, ...(reason ? { reason } : {}) };
  }

  if (type === "session.denied") {
    const reason = nonEmptyString(payload.reason);
    if (!reason) return null;
    const requestType = nonEmptyString(payload.requestType);
    return {
      kind: "denied",
      reason,
      ...(requestType ? { requestType } : {}),
    };
  }

  if (type === "pty.ready") {
    const tabRole = role(payload.role);
    if (!tabRole || typeof payload.resumed !== "boolean") return null;
    // A malformed `limits` is dropped to undefined rather than partially
    // trusted: "the host said something about limits" is not a capability, and
    // half-reading one would chunk against a host that never claimed it could
    // assemble chunks.
    const advertised = record(payload.limits);
    const maxFileBytes = safeInteger(advertised?.maxFileBytes);
    const maxUploadChunkBytes = safeInteger(advertised?.maxUploadChunkBytes);
    const limits =
      maxFileBytes !== null &&
      maxUploadChunkBytes !== null &&
      maxFileBytes > 0 &&
      maxUploadChunkBytes > 0
        ? { maxFileBytes, maxUploadChunkBytes }
        : undefined;
    return {
      kind: "ready",
      role: tabRole,
      resumed: payload.resumed,
      ...(limits ? { limits } : {}),
    };
  }

  if (type === "file.progress") {
    const requestId = nonEmptyString(payload.requestId);
    const uploadId = nonEmptyString(payload.uploadId);
    const received = safeInteger(payload.received);
    const chunks = safeInteger(payload.chunks);
    const count = safeInteger(payload.count);
    if (
      !requestId ||
      !uploadId ||
      received === null ||
      chunks === null ||
      count === null
    ) {
      return null;
    }
    return { kind: "upload-progress", requestId, uploadId, received, chunks, count };
  }

  if (type === "pty.output" || type === "pty.snapshot") {
    const data = nonEmptyString(payload.data);
    if (!data) return null;
    try {
      return {
        kind: "terminal-data",
        source: type === "pty.output" ? "output" : "snapshot",
        data: base64ToBytes(data),
      };
    } catch {
      return null;
    }
  }

  if (type === "pty.exit") {
    const code = safeInteger(payload.code);
    const signal = safeInteger(payload.signal);
    return code === null || signal === null
      ? null
      : { kind: "exit", code, signal };
  }

  if (type === "file.result") {
    const requestId = nonEmptyString(payload.requestId);
    const operation = fileOperation(payload.operation);
    if (!requestId || !operation) return null;
    const entries = fileEntries(payload.entries);
    const path = nonEmptyString(payload.path);
    const bytes = safeInteger(payload.bytes);
    const data = typeof payload.data === "string" ? payload.data : undefined;
    const encoding =
      payload.encoding === "utf8" || payload.encoding === "base64"
        ? payload.encoding
        : undefined;
    return {
      kind: "file-result",
      requestId,
      operation,
      ...(entries ? { entries } : {}),
      ...(path ? { path } : {}),
      ...(bytes !== null && bytes >= 0 ? { bytes } : {}),
      ...(data !== undefined ? { data } : {}),
      ...(encoding ? { encoding } : {}),
    };
  }

  if (type === "operation.error") {
    const operation = nonEmptyString(payload.operation);
    const code = nonEmptyString(payload.code);
    if (!operation || !code) return null;
    const requestId = nonEmptyString(payload.requestId);
    return {
      kind: "operation-error",
      operation,
      code,
      ...(requestId ? { requestId } : {}),
    };
  }

  return null;
}
