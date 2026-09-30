"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clipboard,
  Download,
  Files,
  TerminalSquare,
  Upload,
} from "lucide-react";
import { Button } from "@/app/harness/Button";
import "@xterm/xterm/css/xterm.css";
import styles from "./hosted-workspace-session.module.css";
import {
  base64ToBytes,
  base64ToUtf8,
  buildHostedWorkspaceSocketUrl,
  bytesToBase64,
  formatUploadBytes,
  parseHostedWorkspaceProtocolMessage,
  readHostedWorkspaceId,
  readHostedWorkspaceTicket,
  utf8ToBase64,
  HOSTED_WORKSPACE_MAX_WHOLE_FILE_BYTES,
  type HostedWorkspaceFileEntry,
  type HostedWorkspaceSessionStatus,
  type HostedWorkspaceTabRole,
  type HostedWorkspaceUploadLimits,
} from "./hosted-workspace-session-protocol";
import { planChunks } from "@papercusp/sync";
import {
  parseHostedDesktopProtocolMessage,
  type HostedDesktopRosterEntry,
  type HostedDesktopThumbnailResult,
} from "./hosted-desktop-viewer-protocol";

export type HostedDesktopQueryState = "idle" | "loading" | "ready" | "error";

/**
 * How long one chunk waits for its `file.progress` ack before the upload is
 * abandoned.
 *
 * A bounded wait is what keeps a failed upload from becoming a hung one: the
 * host answers a rejected chunk with `operation.error`, never a progress ack,
 * so without a deadline the send loop would wait on an ack that is never
 * coming and the UI would sit on "Uploading…" forever.
 */
const UPLOAD_CHUNK_ACK_TIMEOUT_MS = 30_000;

/**
 * How long a `desktop.start` may go unanswered before the viewer reports it.
 *
 * Above the host's own 60s provisioning deadline, so a slow start still lands.
 * The deadline exists for version skew: a host on a runtime older than D-405
 * ignores the request entirely, and without one the page would say "Starting
 * your desktop…" forever.
 */
export const DESKTOP_START_TIMEOUT_MS = 90_000;

/**
 * The PTY/control channel is the authenticated discovery plane for desktops.
 * The returned callbacks deliberately do not expose the raw socket: callers
 * can request bounded roster/thumbnail reads, while the selected desktop's
 * media channel remains a separate connection owned by HostedDesktopViewer.
 */
export interface HostedWorkspaceDesktopBridge {
  requestRoster: () => boolean;
  requestThumbnail: (desktopSessionId: string) => boolean;
  /**
   * Ask the host to start the workspace desktop, or return the running one
   * (D-405). False without sending when this tab is not the controller: the
   * host refuses an observer, and watching must never start a desktop.
   */
  requestStart: () => boolean;
}

export type HostedDesktopOperation = "roster" | "thumbnail" | "start";

export interface HostedWorkspaceSessionProps {
  hostId: string;
  routeLabel: string;
  workspaceName: string;
  onWorkspaceIdChange?: (workspaceId: string) => void;
  onDesktopBridgeChange?: (bridge: HostedWorkspaceDesktopBridge | null) => void;
  onDesktopRosterChange?: (desktops: HostedDesktopRosterEntry[]) => void;
  onDesktopThumbnailChange?: (result: HostedDesktopThumbnailResult) => void;
  onDesktopStarted?: (desktop: HostedDesktopRosterEntry) => void;
  onDesktopQueryStateChange?: (
    state: HostedDesktopQueryState,
    operation?: HostedDesktopOperation,
    code?: string,
  ) => void;
}

type SessionMeta = {
  channelId?: string;
  generation?: number;
  resumed?: boolean;
};

type JsonRecord = Record<string, unknown>;

export function isCurrentHostedWorkspaceSocket(
  socket: WebSocket,
  socketEpoch: number,
  activeSocket: WebSocket | null,
  activeEpoch: number,
): boolean {
  return socket === activeSocket && socketEpoch === activeEpoch;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function responseError(value: unknown, fallback: string): string {
  const payload = record(value);
  const error = record(payload?.error);
  const code =
    typeof error?.code === "string"
      ? error.code
      : typeof payload?.error === "string"
        ? payload.error
        : null;
  return code ? `${fallback}: ${code}` : fallback;
}

function requestId(prefix: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function joinPath(parent: string, child: string): string {
  const base = parent === "." ? "" : parent.replace(/\/+$/, "");
  return `${base}/${child}`.replace(/^\//, "");
}

function fileSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function downloadFile(path: string, data: string): void {
  const bytes = base64ToBytes(data);
  // Copy into a concrete ArrayBuffer: Uint8Array<ArrayBufferLike> also permits
  // SharedArrayBuffer, which the DOM BlobPart type intentionally rejects.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer]);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = path.split("/").pop() || "workspace-download";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function HostedWorkspaceSession({
  hostId,
  routeLabel,
  workspaceName,
  onWorkspaceIdChange,
  onDesktopBridgeChange,
  onDesktopRosterChange,
  onDesktopThumbnailChange,
  onDesktopStarted,
  onDesktopQueryStateChange,
}: HostedWorkspaceSessionProps) {
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const resizeRef = useRef<ResizeObserver | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const roleRef = useRef<HostedWorkspaceTabRole | null>(null);
  /*
   * The relay's message listener is registered ONCE, inside connect(), so it
   * keeps calling the `handleMessage` that existed at connect time. Anything
   * that handler reads straight from render scope is therefore frozen at its
   * connect-time value — which for `path` meant every post-operation refresh
   * re-listed the root and dragged the operator out of their directory. Same
   * reason `roleRef` exists for the terminal callbacks. `pathRef` now carries
   * the last directory confirmed by a successful list; `draftPathRef` keeps
   * the editable input separate so a failed request cannot make the UI claim
   * that an unlisted directory is current.
   */
  const pathRef = useRef(".");
  const draftPathRef = useRef(".");
  const pendingListPathsRef = useRef(new Map<string, string>());
  const pendingDesktopRequestsRef = useRef(
    new Map<string, HostedDesktopOperation>(),
  );
  const connectEpochRef = useRef(0);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  /**
   * Upload capability the CURRENT host advertised, or null when it advertised
   * none. Null is a real state meaning "whole-file only", not "not yet known":
   * an older host never sends it, so waiting for it would hang forever.
   */
  const uploadLimitsRef = useRef<HostedWorkspaceUploadLimits | null>(null);
  /** Resolvers for in-flight chunk acks, keyed by uploadId. */
  const uploadAckRef = useRef(new Map<string, () => void>());
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRefs = useRef({
    onWorkspaceIdChange,
    onDesktopBridgeChange,
    onDesktopRosterChange,
    onDesktopThumbnailChange,
    onDesktopStarted,
    onDesktopQueryStateChange,
  });
  callbackRefs.current = {
    onWorkspaceIdChange,
    onDesktopBridgeChange,
    onDesktopRosterChange,
    onDesktopThumbnailChange,
    onDesktopStarted,
    onDesktopQueryStateChange,
  };

  const [status, setStatus] = useState<HostedWorkspaceSessionStatus>("idle");
  const [role, setRole] = useState<HostedWorkspaceTabRole | null>(null);
  const [meta, setMeta] = useState<SessionMeta>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<HostedWorkspaceFileEntry[]>([]);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(
    null,
  );

  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  useEffect(() => {
    draftPathRef.current = path;
  }, [path]);

  const send = useCallback((payload: unknown): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }, []);

  const requestDesktopRoster = useCallback(() => {
    const requestIdValue = requestId("desktop-roster");
    if (!send({ type: "desktop.roster", requestId: requestIdValue })) {
      callbackRefs.current.onDesktopQueryStateChange?.(
        "error",
        "roster",
        "relay_unavailable",
      );
      return false;
    }
    pendingDesktopRequestsRef.current.set(requestIdValue, "roster");
    callbackRefs.current.onDesktopQueryStateChange?.("loading", "roster");
    return true;
  }, [send]);

  const requestDesktopThumbnail = useCallback(
    (desktopSessionId: string) => {
      const normalized = desktopSessionId.trim();
      if (!normalized) return false;
      const requestIdValue = requestId("desktop-thumbnail");
      if (
        !send({
          type: "desktop.thumbnail",
          requestId: requestIdValue,
          desktopSessionId: normalized,
        })
      ) {
        callbackRefs.current.onDesktopQueryStateChange?.(
          "error",
          "thumbnail",
          "relay_unavailable",
        );
        return false;
      }
      pendingDesktopRequestsRef.current.set(requestIdValue, "thumbnail");
      callbackRefs.current.onDesktopQueryStateChange?.("loading", "thumbnail");
      return true;
    },
    [send],
  );

  const requestDesktopStart = useCallback(() => {
    if (roleRef.current !== "controller") return false;
    const requestIdValue = requestId("desktop-start");
    if (!send({ type: "desktop.start", requestId: requestIdValue })) {
      callbackRefs.current.onDesktopQueryStateChange?.(
        "error",
        "start",
        "relay_unavailable",
      );
      return false;
    }
    pendingDesktopRequestsRef.current.set(requestIdValue, "start");
    callbackRefs.current.onDesktopQueryStateChange?.("loading", "start");
    if (startTimerRef.current) clearTimeout(startTimerRef.current);
    startTimerRef.current = setTimeout(() => {
      startTimerRef.current = null;
      if (!pendingDesktopRequestsRef.current.delete(requestIdValue)) return;
      callbackRefs.current.onDesktopQueryStateChange?.(
        "error",
        "start",
        "desktop_start_timeout",
      );
    }, DESKTOP_START_TIMEOUT_MS);
    return true;
  }, [send]);

  const desktopBridge = useMemo<HostedWorkspaceDesktopBridge>(
    () => ({
      requestRoster: requestDesktopRoster,
      requestThumbnail: requestDesktopThumbnail,
      requestStart: requestDesktopStart,
    }),
    [requestDesktopRoster, requestDesktopThumbnail, requestDesktopStart],
  );

  const dispose = useCallback((notify = true) => {
    connectEpochRef.current += 1;
    const socket = socketRef.current;
    socketRef.current = null;
    pendingListPathsRef.current.clear();
    pendingDesktopRequestsRef.current.clear();
    if (startTimerRef.current) clearTimeout(startTimerRef.current);
    startTimerRef.current = null;
    callbackRefs.current.onDesktopBridgeChange?.(null);
    callbackRefs.current.onDesktopQueryStateChange?.("idle");
    if (socket && notify && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "session.detach" }));
      } catch {
        // The close below is still authoritative cleanup.
      }
    }
    try {
      socket?.close(1000, "browser_detached");
    } catch {
      // Already closed.
    }
    resizeRef.current?.disconnect();
    resizeRef.current = null;
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitRef.current = null;
    roleRef.current = null;
  }, []);

  useEffect(() => () => dispose(true), [dispose]);

  const initializeTerminal = useCallback(async () => {
    if (!terminalContainerRef.current) {
      throw new Error("terminal_container_unavailable");
    }
    terminalRef.current?.dispose();
    resizeRef.current?.disconnect();
    const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
    ]);
    const terminal = new Terminal({
      cols: 120,
      rows: 32,
      cursorBlink: true,
      convertEol: true,
      scrollback: 5_000,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: { background: "#101418", foreground: "#d9e1e8" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(
      new WebLinksAddon((_, url) => window.open(url, "_blank", "noopener")),
    );
    terminal.open(terminalContainerRef.current);
    try {
      fit.fit();
    } catch {
      // The first ResizeObserver turn retries after layout settles.
    }
    terminal.onData((data) => {
      if (roleRef.current !== "controller") return;
      send({ type: "pty.input", data: utf8ToBase64(data) });
    });
    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
        if (roleRef.current === "controller") {
          send({
            type: "pty.resize",
            cols: terminal.cols,
            rows: terminal.rows,
          });
        }
      } catch {
        // A hidden or unmounted terminal has no measurable geometry.
      }
    });
    resize.observe(terminalContainerRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    resizeRef.current = resize;
  }, [send]);

  const listFiles = useCallback(
    (target = draftPathRef.current) => {
      const listRequestId = requestId("list");
      if (send({ type: "file.list", requestId: listRequestId, path: target })) {
        pendingListPathsRef.current.set(listRequestId, target);
        setNotice(`Listing ${target}…`);
      }
    },
    [send],
  );

  const handleMessage = useCallback(
    (raw: string) => {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return;
      }

      /* Desktop discovery deliberately rides this already-authenticated PTY
       * channel. Keep its responses out of the terminal/file state machine;
       * the selected desktop's pixel stream is opened separately by the
       * viewer, per D-017. */
      const desktopEvent = parseHostedDesktopProtocolMessage(value);
      if (desktopEvent?.kind === "roster") {
        pendingDesktopRequestsRef.current.delete(desktopEvent.requestId);
        callbackRefs.current.onDesktopRosterChange?.(desktopEvent.desktops);
        callbackRefs.current.onDesktopQueryStateChange?.("ready", "roster");
        return;
      }
      if (desktopEvent?.kind === "thumbnail") {
        pendingDesktopRequestsRef.current.delete(desktopEvent.requestId);
        callbackRefs.current.onDesktopThumbnailChange?.({
          desktopSessionId: desktopEvent.desktopSessionId,
          data: desktopEvent.data,
          ...(desktopEvent.bytes !== undefined
            ? { bytes: desktopEvent.bytes }
            : {}),
        });
        callbackRefs.current.onDesktopQueryStateChange?.("ready", "thumbnail");
        return;
      }
      if (desktopEvent?.kind === "started") {
        pendingDesktopRequestsRef.current.delete(desktopEvent.requestId);
        callbackRefs.current.onDesktopStarted?.(desktopEvent.desktop);
        callbackRefs.current.onDesktopQueryStateChange?.("ready", "start");
        return;
      }
      if (
        desktopEvent?.kind === "error" &&
        (desktopEvent.operation.startsWith("desktop.") ||
          (desktopEvent.requestId !== undefined &&
            pendingDesktopRequestsRef.current.has(desktopEvent.requestId)))
      ) {
        if (desktopEvent.requestId) {
          pendingDesktopRequestsRef.current.delete(desktopEvent.requestId);
        }
        const operation = desktopEvent.operation.startsWith("desktop.")
          ? desktopEvent.operation.slice("desktop.".length)
          : undefined;
        callbackRefs.current.onDesktopQueryStateChange?.(
          "error",
          operation === "roster" ||
            operation === "thumbnail" ||
            operation === "start"
            ? operation
            : undefined,
          desktopEvent.code,
        );
        setNotice(`${desktopEvent.operation} failed: ${desktopEvent.code}`);
        return;
      }

      const event = parseHostedWorkspaceProtocolMessage(value);
      if (!event) return;

      if (event.kind === "bound") {
        setRole(event.role);
        setMeta((current) => ({
          ...current,
          channelId: event.channelId,
          generation: event.generation,
        }));
        setNotice(`Bound to connector generation ${event.generation}`);
        return;
      }
      if (event.kind === "role") {
        setRole(event.role);
        setNotice(
          event.role === "controller"
            ? "This tab controls the workspace session."
            : "Another tab controls this session; output remains live.",
        );
        return;
      }
      if (event.kind === "upload-progress") {
        uploadAckRef.current.get(event.uploadId)?.();
        return;
      }
      if (event.kind === "ready") {
        setRole(event.role);
        uploadLimitsRef.current = event.limits ?? null;
        setMeta((current) => ({ ...current, resumed: event.resumed }));
        setStatus("live");
        callbackRefs.current.onDesktopBridgeChange?.(desktopBridge);
        setNotice(
          event.resumed ? "Detached session resumed." : "New session ready.",
        );
        /* Discovery is a control-plane read, so make the picker useful as soon
         * as the authenticated PTY is ready. It never opens a second SSE or
         * media socket. */
        requestDesktopRoster();
        listFiles(".");
        return;
      }
      if (event.kind === "terminal-data") {
        terminalRef.current?.write(event.data);
        return;
      }
      if (event.kind === "exit") {
        terminalRef.current?.writeln(
          `\r\n\u001b[33m[process exited: ${event.code}, signal ${event.signal}]\u001b[0m`,
        );
        pendingDesktopRequestsRef.current.clear();
        callbackRefs.current.onDesktopBridgeChange?.(null);
        callbackRefs.current.onDesktopQueryStateChange?.("idle");
        setStatus("closed");
        setNotice("The remote PTY exited; reconnect to start a new session.");
        return;
      }
      if (event.kind === "denied") {
        setNotice(
          `${event.requestType ?? "Operation"} denied: ${event.reason}. Claim control to mutate the session.`,
        );
        return;
      }
      if (event.kind === "operation-error") {
        if (event.operation === "list") {
          if (event.requestId)
            pendingListPathsRef.current.delete(event.requestId);
          /* A failed list never confirms the editable path. Restore the last
             directory whose entries we actually received. */
          draftPathRef.current = pathRef.current;
          setPath(pathRef.current);
        }
        setNotice(`${event.operation} failed: ${event.code}`);
        return;
      }
      if (event.kind === "file-result") {
        if (event.operation === "list") {
          const listedPath =
            pendingListPathsRef.current.get(event.requestId) ??
            event.path ??
            pathRef.current;
          pendingListPathsRef.current.delete(event.requestId);
          pathRef.current = listedPath;
          draftPathRef.current = listedPath;
          setPath(listedPath);
          setEntries(event.entries ?? []);
          setNotice(
            `Listed ${event.entries?.length ?? 0} entries in ${listedPath}.`,
          );
        } else if (event.operation === "read" && event.data !== undefined) {
          try {
            const text =
              event.encoding === "utf8" ? event.data : base64ToUtf8(event.data);
            setPreview({ path: event.path ?? "file", text });
            setNotice(`Read ${event.path ?? "file"}.`);
          } catch {
            setNotice("The selected file is not valid UTF-8 text.");
          }
        } else if (event.operation === "download" && event.data !== undefined) {
          try {
            downloadFile(event.path ?? "workspace-download", event.data);
            setNotice(`Downloaded ${event.path ?? "file"}.`);
          } catch {
            setNotice("The download payload was invalid.");
          }
        } else {
          setNotice(`${event.operation} completed.`);
          listFiles();
        }
      }
    },
    [desktopBridge, listFiles, requestDesktopRoster],
  );

  const connect = useCallback(async () => {
    dispose(false);
    const epoch = connectEpochRef.current;
    setStatus("ticketing");
    setError(null);
    setNotice("Resolving the hosted workspace session…");
    setRole(null);
    setMeta({});
    setEntries([]);
    setPreview(null);

    try {
      await initializeTerminal();
      const sessionResponse = await fetch("/api/hosted/auth/session", {
        cache: "no-store",
      });
      const sessionPayload = await sessionResponse.json().catch(() => null);
      const workspaceId = readHostedWorkspaceId(sessionPayload);
      if (!sessionResponse.ok || !workspaceId) {
        throw new Error(
          responseError(
            sessionPayload,
            "Hosted sign-in with a selected workspace is required",
          ),
        );
      }
      callbackRefs.current.onWorkspaceIdChange?.(workspaceId);

      const ticketResponse = await fetch(
        `/api/hosted/workspaces/${encodeURIComponent(workspaceId)}/connectors/session-ticket`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            hostId,
            routeLabel,
            transport: "websocket",
            audience: "workspace-operator",
          }),
        },
      );
      const ticketPayload = await ticketResponse.json().catch(() => null);
      const ticket = readHostedWorkspaceTicket(ticketPayload);
      if (!ticketResponse.ok || !ticket) {
        throw new Error(
          responseError(
            ticketPayload,
            "Could not mint a workspace session ticket",
          ),
        );
      }
      if (epoch !== connectEpochRef.current) return;

      setStatus("connecting");
      setNotice("Opening the generation-bound workspace relay…");
      const socket = new WebSocket(
        buildHostedWorkspaceSocketUrl(window.location.origin, ticket),
      );
      const socketEpoch = epoch;
      socketRef.current = socket;
      socket.addEventListener("message", (event) => {
        if (
          !isCurrentHostedWorkspaceSocket(
            socket,
            socketEpoch,
            socketRef.current,
            connectEpochRef.current,
          )
        )
          return;
        if (typeof event.data === "string") handleMessage(event.data);
      });
      socket.addEventListener("close", (event) => {
        if (
          !isCurrentHostedWorkspaceSocket(
            socket,
            socketEpoch,
            socketRef.current,
            connectEpochRef.current,
          )
        )
          return;
        socketRef.current = null;
        pendingDesktopRequestsRef.current.clear();
        callbackRefs.current.onDesktopBridgeChange?.(null);
        callbackRefs.current.onDesktopQueryStateChange?.("idle");
        setStatus((current) => (current === "error" ? current : "closed"));
        setNotice(
          event.reason
            ? `Workspace relay closed: ${event.reason}`
            : "Workspace relay closed.",
        );
      });
      socket.addEventListener("error", () => {
        if (
          !isCurrentHostedWorkspaceSocket(
            socket,
            socketEpoch,
            socketRef.current,
            connectEpochRef.current,
          )
        )
          return;
        pendingDesktopRequestsRef.current.clear();
        callbackRefs.current.onDesktopBridgeChange?.(null);
        callbackRefs.current.onDesktopQueryStateChange?.("idle");
        setError("The workspace relay connection failed.");
        setStatus("error");
      });
    } catch (cause) {
      if (epoch !== connectEpochRef.current) return;
      callbackRefs.current.onDesktopBridgeChange?.(null);
      callbackRefs.current.onDesktopQueryStateChange?.("idle");
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  }, [dispose, handleMessage, hostId, initializeTerminal, routeLabel]);

  const disconnect = useCallback(() => {
    dispose(true);
    setStatus("closed");
    setRole(null);
    setNotice(
      "Session detached. Reconnect within the idle window to resume it.",
    );
  }, [dispose]);

  const paste = useCallback(async () => {
    if (role !== "controller") return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) send({ type: "pty.input", data: utf8ToBase64(text) });
    } catch {
      setNotice("Clipboard read permission was denied.");
    }
  }, [role, send]);

  const copy = useCallback(async () => {
    const selection = terminalRef.current?.getSelection() ?? "";
    if (!selection) {
      setNotice("Select terminal text before copying.");
      return;
    }
    try {
      await navigator.clipboard.writeText(selection);
      setNotice("Terminal selection copied.");
    } catch {
      setNotice("Clipboard write permission was denied.");
    }
  }, []);

  const openEntry = useCallback(
    (entry: HostedWorkspaceFileEntry) => {
      const target = joinPath(path, entry.name);
      if (entry.kind === "directory") listFiles(target);
      else
        send({
          type: "file.read",
          requestId: requestId("read"),
          path: target,
        });
    },
    [listFiles, path, send],
  );

  const download = useCallback(() => {
    if (!path || path === ".") {
      setNotice("Enter a file path before downloading.");
      return;
    }
    if (
      !send({
        type: "file.download",
        requestId: requestId("download"),
        path,
      })
    ) {
      setNotice("Workspace relay unavailable; reconnect before downloading.");
    }
  }, [path, send]);

  const upload = useCallback(
    async (file: File) => {
      if (role !== "controller") return;
      const target = joinPath(path === "." ? "" : path, file.name);
      const limits = uploadLimitsRef.current;
      const requestIdValue = requestId("upload");
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());

        /* WHOLE-FILE PATH — the only shape a host that advertised no `limits`
         * can assemble, so chunking here would corrupt rather than help.
         *
         * The size refusal is the substance of this branch. Above the envelope
         * cap the relay closes the socket instead of answering, taking the
         * terminal down with the upload, so the client must decline BEFORE
         * sending. Declining converts a destroyed session into a sentence the
         * user can act on. */
        if (!limits) {
          if (bytes.byteLength > HOSTED_WORKSPACE_MAX_WHOLE_FILE_BYTES) {
            setNotice(
              `${file.name} is ${formatUploadBytes(bytes.byteLength)}; this workspace host accepts at most ${formatUploadBytes(HOSTED_WORKSPACE_MAX_WHOLE_FILE_BYTES)} per upload. Reconnect once the host is updated to send larger files.`,
            );
            return;
          }
          if (
            !send({
              type: "file.upload",
              requestId: requestIdValue,
              path: target,
              encoding: "base64",
              data: bytesToBase64(bytes),
            })
          ) {
            setNotice("Workspace relay unavailable; reconnect before uploading.");
            return;
          }
          setNotice(`Uploading ${target}…`);
          return;
        }

        if (bytes.byteLength > limits.maxFileBytes) {
          setNotice(
            `${file.name} is ${formatUploadBytes(bytes.byteLength)}; this workspace accepts at most ${formatUploadBytes(limits.maxFileBytes)}.`,
          );
          return;
        }

        /* CHUNKED PATH. `planChunks` is the shared transfer-plane splitter from
         * @papercusp/sync, reused rather than re-derived so the chunk maths has
         * exactly one home. */
        const uploadId = requestId("upload-id");
        const chunks = planChunks(bytes.byteLength, limits.maxUploadChunkBytes);
        try {
          for (const chunk of chunks) {
            const final = chunk.index === chunks.length - 1;
            /* Registered BEFORE the send: an ack can arrive before the await
             * is reached, and a resolver installed afterwards would miss it and
             * stall the upload until the timeout. */
            const acked = final
              ? null
              : new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(() => {
                    uploadAckRef.current.delete(uploadId);
                    reject(
                      new Error(
                        `the workspace host stopped acknowledging chunks after ${chunk.index}/${chunks.length}`,
                      ),
                    );
                  }, UPLOAD_CHUNK_ACK_TIMEOUT_MS);
                  uploadAckRef.current.set(uploadId, () => {
                    clearTimeout(timer);
                    resolve();
                  });
                });
            if (
              !send({
                type: "file.upload",
                requestId: requestIdValue,
                path: target,
                encoding: "base64",
                data: bytesToBase64(bytes.subarray(chunk.start, chunk.end)),
                chunk: { uploadId, index: chunk.index, count: chunks.length },
              })
            ) {
              /* Settle the ack we just armed before bailing. Returning straight
               * out would leave its timeout live to reject a promise nobody is
               * awaiting — an unhandled rejection raised 30s after a failure the
               * user was already told about. */
              uploadAckRef.current.get(uploadId)?.();
              setNotice("Workspace relay unavailable; reconnect before uploading.");
              return;
            }
            /* The final chunk is answered by `file.result`, not `file.progress`
             * — awaiting an ack for it would hang on a SUCCEEDED upload. */
            if (!acked) break;
            await acked;
            setNotice(
              `Uploading ${target}… ${chunk.index + 1}/${chunks.length}`,
            );
          }
        } finally {
          uploadAckRef.current.delete(uploadId);
        }
        setNotice(`Uploading ${target}…`);
      } catch (cause) {
        setNotice(
          `Upload failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    },
    [path, role, send],
  );

  const live = status === "live";
  const controller = live && role === "controller";
  const statusTone =
    status === "live" ? "good" : status === "error" ? "bad" : "neutral";

  return (
    <section
      className={styles.shell}
      aria-label={`Browser workspace session for ${workspaceName}`}
    >
      <div className={styles.header}>
        <div>
          <strong>Browser workspace session</strong>
          <small>
            <TerminalSquare size={12} aria-hidden="true" /> outbound relay ·{" "}
            {routeLabel}
          </small>
        </div>
        <div className={styles.headerActions}>
          {role === "observer" ? (
            <button
              type="button"
              className={styles.claimButton}
              onClick={() => send({ type: "session.claim-control" })}
            >
              Claim control
            </button>
          ) : null}
          {live || status === "connecting" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={disconnect}
            >
              Detach
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void connect()}
              disabled={status === "ticketing"}
            >
              {status === "closed" ? "Reconnect" : "Connect"}
            </Button>
          )}
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.terminalPane}>
          <div
            className={styles.status}
            data-tone={statusTone}
            aria-live="polite"
          >
            <span>{status}</span>
            {role ? <span>· {role}</span> : null}
            {meta.generation !== undefined ? (
              <span>· generation {meta.generation}</span>
            ) : null}
            {meta.resumed !== undefined ? (
              <span>· {meta.resumed ? "resumed" : "new PTY"}</span>
            ) : null}
            {error ? <span className={styles.error}>· {error}</span> : null}
          </div>
          <div className={styles.terminal} ref={terminalContainerRef}>
            {!live ? (
              <div className={styles.terminalPlaceholder}>
                Connect to open the authenticated PTY. A detached PTY remains
                resumable until its idle expiry.
              </div>
            ) : null}
          </div>
          <div className={styles.toolbar} aria-label="Terminal actions">
            <button type="button" onClick={() => void copy()} disabled={!live}>
              <Clipboard size={12} aria-hidden="true" /> Copy
            </button>
            <button
              type="button"
              onClick={() => void paste()}
              disabled={!controller}
            >
              Paste
            </button>
            <button
              type="button"
              onClick={() => send({ type: "pty.signal", signal: "SIGINT" })}
              disabled={!controller}
            >
              Ctrl-C
            </button>
            <button
              type="button"
              onClick={() => send({ type: "pty.signal", signal: "SIGTERM" })}
              disabled={!controller}
            >
              Terminate
            </button>
          </div>
        </div>

        <div className={styles.filePane}>
          <div className={styles.fileHeader}>
            <strong>
              <Files size={12} aria-hidden="true" /> Safe-root files
            </strong>
            <span>{entries.length} entries</span>
          </div>
          <div className={styles.fileToolbar}>
            <input
              className={styles.pathInput}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              aria-label="Workspace file path"
            />
            <button
              type="button"
              onClick={() => listFiles(path)}
              disabled={!live}
            >
              List
            </button>
            <button type="button" onClick={download} disabled={!live}>
              <Download size={12} aria-hidden="true" /> Download
            </button>
            <button
              type="button"
              onClick={() => uploadRef.current?.click()}
              disabled={!controller}
            >
              <Upload size={12} aria-hidden="true" /> Upload
            </button>
            <input
              ref={uploadRef}
              className={styles.uploadInput}
              type="file"
              aria-label="Upload workspace file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
                event.target.value = "";
              }}
            />
          </div>
          {entries.length ? (
            <ul className={styles.fileList}>
              {entries.map((entry) => (
                <li
                  className={styles.fileEntry}
                  key={`${entry.kind}:${entry.name}`}
                >
                  <button
                    type="button"
                    onClick={() => openEntry(entry)}
                    disabled={!live}
                  >
                    {entry.kind === "directory" ? "▸" : "·"} {entry.name}
                  </button>
                  <small>
                    {entry.kind === "directory" ? "dir" : fileSize(entry.bytes)}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>No directory listing loaded.</p>
          )}
          <div className={styles.preview}>
            <span className={styles.previewLabel}>
              {preview?.path ?? "Text preview"}
            </span>
            <pre>
              {preview?.text ??
                "Select a file to read it through the safe-root file plane."}
            </pre>
          </div>
        </div>
      </div>
      {notice ? (
        <div className={styles.notice} aria-live="polite">
          {notice}
        </div>
      ) : null}
    </section>
  );
}
