"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Expand,
  Eye,
  Minimize2,
  Monitor,
  MousePointer2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/app/harness/Button";
import {
  buildHostedDesktopSocketUrl,
  HOSTED_DESKTOP_CONNECT_ATTEMPTS,
  HOSTED_DESKTOP_CONNECT_DEADLINE_MS,
  HostedDesktopRelayChannel,
  readHostedDesktopTicket,
  type HostedDesktopViewerMode,
} from "./hosted-desktop-viewer-protocol";
import { readHostedWorkspaceTicket } from "./hosted-workspace-session-protocol";
import { kasmvncRfbClass } from "./kasmvnc-rfb";
import styles from "./hosted-workspace-session.module.css";

export type HostedDesktopViewerState =
  | "idle"
  | "ticketing"
  | "connecting"
  | "connected"
  | "closed"
  | "error";

function responseError(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fallback;
  const payload = value as Record<string, unknown>;
  const nested =
    payload.error &&
    typeof payload.error === "object" &&
    !Array.isArray(payload.error)
      ? (payload.error as Record<string, unknown>)
      : null;
  const code =
    typeof nested?.code === "string"
      ? nested.code
      : typeof payload.error === "string"
        ? payload.error
        : null;
  return code ? `${fallback}: ${code}` : fallback;
}

export interface HostedDesktopViewerProps {
  workspaceId: string;
  hostId: string;
  routeLabel: string;
  desktopSessionId: string;
  desktopLabel?: string;
  mode?: HostedDesktopViewerMode;
  onStateChange?: (state: HostedDesktopViewerState) => void;
  onModeChange?: (mode: HostedDesktopViewerMode) => void;
  canTakeControl?: boolean;
}

export function HostedDesktopViewer({
  workspaceId,
  hostId,
  routeLabel,
  desktopSessionId,
  desktopLabel,
  mode = "watch",
  onStateChange,
  onModeChange,
  canTakeControl = true,
}: HostedDesktopViewerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const channelRef = useRef<HostedDesktopRelayChannel | null>(null);
  const rfbRef = useRef<import("@novnc/novnc").default | null>(null);
  const epochRef = useRef(0);
  const readyRejectedRef = useRef(false);
  const controlButtonRef = useRef<HTMLButtonElement | null>(null);
  const [state, setState] = useState<HostedDesktopViewerState>("idle");
  const [attempt, setAttempt] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [inputAllowed, setInputAllowed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const updateState = useCallback(
    (next: HostedDesktopViewerState) => {
      setState(next);
      onStateChange?.(next);
    },
    [onStateChange],
  );

  const disconnect = useCallback(() => {
    epochRef.current += 1;
    readyRejectedRef.current = false;
    setInputAllowed(false);
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    channelRef.current?.close(1000, "viewer_detached");
    channelRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    try {
      socket?.close(1000, "viewer_detached");
    } catch {
      // Already closed.
    }
  }, []);

  const connect = useCallback(async (nextAttempt = 1) => {
    disconnect();
    const epoch = epochRef.current;
    setAttempt(nextAttempt);
    setError(null);
    setInputAllowed(false);
    readyRejectedRef.current = false;
    updateState("ticketing");

    try {
      const response = await fetch(
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
      const payload = await response.json().catch(() => null);
      const ticket =
        readHostedDesktopTicket(payload) ?? readHostedWorkspaceTicket(payload);
      if (!response.ok || !ticket) {
        throw new Error(
          responseError(payload, "Could not mint a desktop viewer ticket"),
        );
      }
      if (epoch !== epochRef.current || !stageRef.current) return;

      updateState("connecting");
      const socket = new WebSocket(
        buildHostedDesktopSocketUrl(
          window.location.origin,
          ticket,
          desktopSessionId,
          mode,
        ),
      );
      socketRef.current = socket;
      const channel = new HostedDesktopRelayChannel(socket);
      channelRef.current = channel;
      channel.onready = (event) => {
        if (epoch !== epochRef.current) return;
        /* The relay reports the credential actually granted. A mismatch is a
         * fail-closed protocol error, never a reason to show takeover chrome
         * for a watch credential (or vice versa). */
        if (event.action !== mode) {
          readyRejectedRef.current = true;
          setInputAllowed(false);
          setError("desktop_action_mismatch");
          updateState("error");
          channel.close(1008, "desktop_action_mismatch");
          return;
        }
        setInputAllowed(mode === "takeover" && event.inputAllowed);
      };
      channel.onopen = () => {
        if (epoch !== epochRef.current) return;
        if (readyRejectedRef.current) return;
        updateState("connecting");
      };
      channel.onerror = (event) => {
        if (epoch !== epochRef.current) return;
        const detail =
          event && typeof event === "object" && "code" in event
            ? String((event as { code?: unknown }).code)
            : "desktop_relay_failed";
        setError(detail);
        updateState("error");
      };
      channel.onclose = (event) => {
        if (epoch !== epochRef.current) return;
        setInputAllowed(false);
        const reason = event.reason?.trim();
        setError(reason || null);
        updateState(readyRejectedRef.current ? "error" : "closed");
      };
      const { default: NoVncRfb } = await import("@novnc/novnc");
      // The desktop is KasmVNC, whose PointerEvent is not the standard one: stock noVNC's
      // first mouse move desyncs the stream and KasmVNC drops Take control (kasmvnc-rfb.ts).
      const RFB = kasmvncRfbClass(NoVncRfb);
      if (epoch !== epochRef.current || !stageRef.current) {
        channel.close(1000, "superseded");
        return;
      }
      const rfb = new RFB(stageRef.current, channel as unknown as WebSocket, {
        shared: true,
      });
      rfb.viewOnly = mode === "watch";
      rfb.scaleViewport = true;
      rfb.clipViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;
      rfb.background =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--bg-deeper")
          .trim() || "#101418";
      rfb.addEventListener("connect", () => {
        if (epoch === epochRef.current) updateState("connected");
      });
      rfb.addEventListener("disconnect", () => {
        if (epoch === epochRef.current) {
          setInputAllowed(false);
          if (!readyRejectedRef.current) updateState("closed");
        }
      });
      rfbRef.current = rfb;
    } catch (cause) {
      if (epoch !== epochRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      updateState("error");
    }
  }, [
    desktopSessionId,
    disconnect,
    hostId,
    mode,
    routeLabel,
    updateState,
    workspaceId,
  ]);

  useEffect(() => {
    void connect();
    return () => disconnect();
  }, [connect, disconnect]);

  // WI-10004214: an attempt that has not reached `connected` by the deadline is
  // abandoned and retried on a fresh ticket; the last one fails visibly instead of
  // leaving "Opening your desktop…" up indefinitely.
  useEffect(() => {
    if (state !== "ticketing" && state !== "connecting") return;
    const timer = setTimeout(() => {
      if (attempt < HOSTED_DESKTOP_CONNECT_ATTEMPTS) {
        void connect(attempt + 1);
        return;
      }
      disconnect();
      setError("desktop_connect_timeout");
      updateState("error");
    }, HOSTED_DESKTOP_CONNECT_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [attempt, connect, disconnect, state, updateState]);

  const changeMode = useCallback(
    (next: HostedDesktopViewerMode) => {
      if (!onModeChange) return;
      // Stop input immediately; the next mode must obtain a fresh scoped ticket.
      if (rfbRef.current) rfbRef.current.viewOnly = true;
      disconnect();
      updateState("idle");
      onModeChange(next);
      controlButtonRef.current?.focus();
    },
    [disconnect, onModeChange, updateState],
  );

  useEffect(() => {
    if (mode !== "takeover" || !onModeChange) return;
    const releaseOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      changeMode("watch");
    };
    // Capture before noVNC can forward Escape to the remote desktop.
    window.addEventListener("keydown", releaseOnEscape, true);
    return () => window.removeEventListener("keydown", releaseOnEscape, true);
  }, [changeMode, mode, onModeChange]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(
        document.fullscreenElement === stageRef.current?.parentElement,
      );
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (typeof document === "undefined") return;
    const target = stageRef.current?.parentElement;
    if (!target || !document.fullscreenEnabled) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await target.requestFullscreen();
    } catch {
      setError("Fullscreen is unavailable in this browser.");
    }
  }, []);

  const fullscreenSupported =
    typeof document !== "undefined" && document.fullscreenEnabled === true;

  const statusLabel =
    state === "connected"
      ? inputAllowed
        ? "connected · takeover"
        : mode === "takeover"
          ? "connected · takeover input unavailable"
          : "connected · watch-only"
      : state === "error"
        ? `error${error ? ` · ${error}` : ""}`
        : state;

  return (
    <section
      className={styles.desktopPanel}
      aria-label={`Desktop viewer${desktopLabel ? ` for ${desktopLabel}` : ""}`}
      data-state={state}
      data-mode={mode}
      data-input-allowed={inputAllowed ? "true" : "false"}
    >
      <div className={styles.desktopHeader}>
        <div>
          <strong>
            <Monitor size={15} aria-hidden="true" />{" "}
            {desktopLabel ?? "Desktop stream"}
          </strong>
          <span>{mode === "takeover" ? "Control requested" : "Watching"}</span>
        </div>
        <div className={styles.desktopActions}>
          <span className={styles.desktopStatus} aria-live="polite">
            {statusLabel}
          </span>
          {onModeChange ? (
            <Button
              ref={controlButtonRef}
              variant={mode === "takeover" ? "neutral" : "primary"}
              onClick={() =>
                changeMode(mode === "takeover" ? "watch" : "takeover")
              }
              disabled={
                mode === "watch" && (!canTakeControl || state !== "connected")
              }
              title={
                mode === "takeover"
                  ? "Release control (Escape)"
                  : "Use this desktop with your mouse and keyboard"
              }
            >
              {mode === "takeover" ? (
                <Eye size={14} aria-hidden="true" />
              ) : (
                <MousePointer2 size={14} aria-hidden="true" />
              )}
              {mode === "takeover" ? "Release control" : "Take control"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void connect()}
            disabled={state === "ticketing" || state === "connecting"}
          >
            <RefreshCw size={12} aria-hidden="true" /> Reconnect
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void toggleFullscreen()}
            disabled={!fullscreenSupported}
            title={
              fullscreenSupported
                ? "Toggle fullscreen desktop viewer"
                : "Fullscreen is unavailable in this browser"
            }
          >
            {fullscreen ? (
              <Minimize2 size={12} aria-hidden="true" />
            ) : (
              <Expand size={12} aria-hidden="true" />
            )}{" "}
            {fullscreen ? "Exit fullscreen" : "Fullscreen"}
          </Button>
        </div>
      </div>
      <div className={styles.desktopStage} ref={stageRef}>
        {state !== "connected" ? (
          <div className={styles.desktopPlaceholder}>
            {state === "error"
              ? `Desktop stream failed${error ? `: ${error}` : "."}`
              : state === "closed"
                ? "Connection lost. Your workspace may still be running. Reconnect to resume watching."
                : attempt > 1
                  ? `Still opening your desktop… retrying (attempt ${attempt} of ${HOSTED_DESKTOP_CONNECT_ATTEMPTS})`
                  : "Opening your desktop…"}
          </div>
        ) : null}
      </div>
      <div className={styles.desktopFooter}>
        <span>
          {inputAllowed
            ? "You have control. Release control or press Escape to return to watching."
            : mode === "takeover"
              ? "Control was requested, but the workspace has not enabled input."
              : "Watch-only mode keeps keyboard and pointer input disabled."}
        </span>
        <div
          className={styles.desktopCapabilities}
          aria-label="Desktop capabilities"
        >
          <span
            data-capability="keyboard-pointer"
            data-supported={inputAllowed}
          >
            Keyboard/pointer: {inputAllowed ? "enabled" : "watch-only"}
          </span>
          <span data-capability="clipboard" data-supported="false">
            Clipboard: unavailable in browser viewer
          </span>
          <span data-capability="audio" data-supported="false">
            Audio: unavailable
          </span>
          <span data-capability="scaling" data-supported="true">
            Scaling: viewport fit enabled
          </span>
          <span data-capability="file-transfer" data-supported="false">
            File transfer: use the workspace file plane
          </span>
        </div>
        <span>PTY and desktop reconnect independently.</span>
      </div>
    </section>
  );
}
