"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Monitor, MousePointer2, RefreshCw } from "lucide-react";
import { Button } from "@/app/harness/Button";
import type { DesktopGridViewerMode } from "@/app/_components/desktop-grid/desktop-grid-model";
import { kasmvncRfbClass } from "./kasmvnc-rfb";
import { requestLocalVncSession } from "./local-desktop-protocol";
import styles from "./hosted-workspace-session.module.css";

export type LocalDesktopViewerState =
  | "idle"
  | "ticketing"
  | "connecting"
  | "connected"
  | "closed"
  | "error";

/** A stream that has not connected by now fails visibly instead of spinning forever. */
export const LOCAL_DESKTOP_CONNECT_DEADLINE_MS = 20_000;

export interface LocalDesktopViewerProps {
  slug: string | null;
  display: number;
  desktopSessionId: string;
  desktopLabel?: string;
  mode?: DesktopGridViewerMode;
  canTakeControl?: boolean;
  /** Absent for a pinned tile: it only watches; take over lives in the large viewer. */
  onModeChange?: (mode: DesktopGridViewerMode) => void;
  onStateChange?: (state: LocalDesktopViewerState) => void;
  fetchImpl?: typeof fetch;
}

/**
 * The live view of one desktop on THIS computer (plan agent-multi-desktops-grid
 * P-007, D-010 / D-015). It mints a single-use, audited session from the operator's
 * loopback VNC bridge, then connects noVNC to it — with the KasmVNC RFB class when
 * the bridge says the far end is KasmVNC (a registry desktop), stock noVNC for an
 * x11vnc stream. Watch is read-only twice over: the bridge grants the view-only
 * credential and `viewOnly` suppresses input. Take control is a fresh session.
 */
export function LocalDesktopViewer({
  slug,
  display,
  desktopSessionId,
  desktopLabel,
  mode = "watch",
  canTakeControl = true,
  onModeChange,
  onStateChange,
  fetchImpl,
}: LocalDesktopViewerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<import("@novnc/novnc").default | null>(null);
  const epochRef = useRef(0);
  const controlButtonRef = useRef<HTMLButtonElement | null>(null);
  const [state, setState] = useState<LocalDesktopViewerState>("idle");
  const [error, setError] = useState<string | null>(null);
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  const updateState = useCallback((next: LocalDesktopViewerState) => {
    setState(next);
    onStateChangeRef.current?.(next);
  }, []);

  const disconnect = useCallback(() => {
    epochRef.current += 1;
    try {
      // viewer-left → the bridge closes the desktop-side stream and clears the viewer.
      rfbRef.current?.disconnect();
    } catch {
      // Already gone.
    }
    rfbRef.current = null;
  }, []);

  const connect = useCallback(async () => {
    disconnect();
    const epoch = epochRef.current;
    setError(null);
    updateState("ticketing");
    try {
      const session = await requestLocalVncSession(
        { slug, display, desktopSessionId, mode },
        fetchImpl,
      );
      if (epoch !== epochRef.current || !stageRef.current) return;
      updateState("connecting");
      const { default: NoVncRfb } = await import("@novnc/novnc");
      if (epoch !== epochRef.current || !stageRef.current) return;
      // KasmVNC's PointerEvent is not the stock one (kasmvnc-rfb.ts); x11vnc's is.
      const RFB = session.rfb === "kasmvnc" ? kasmvncRfbClass(NoVncRfb) : NoVncRfb;
      const rfb = new RFB(stageRef.current, session.wsUrl, { shared: true });
      rfb.viewOnly = mode === "watch";
      rfb.scaleViewport = true;
      rfb.clipViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;
      rfb.background =
        getComputedStyle(document.documentElement).getPropertyValue("--bg-deeper").trim() ||
        "#101418";
      rfb.addEventListener("connect", () => {
        if (epoch === epochRef.current) updateState("connected");
      });
      rfb.addEventListener("disconnect", () => {
        if (epoch === epochRef.current) updateState("closed");
      });
      rfbRef.current = rfb;
    } catch (cause) {
      if (epoch !== epochRef.current) return;
      setError((cause instanceof Error ? cause.message : String(cause)).slice(0, 200));
      updateState("error");
    }
  }, [desktopSessionId, disconnect, display, fetchImpl, mode, slug, updateState]);

  useEffect(() => {
    void connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    if (state !== "ticketing" && state !== "connecting") return;
    const timer = setTimeout(() => {
      disconnect();
      setError("desktop_connect_timeout");
      updateState("error");
    }, LOCAL_DESKTOP_CONNECT_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [disconnect, state, updateState]);

  const changeMode = useCallback(
    (next: DesktopGridViewerMode) => {
      if (!onModeChange) return;
      // Stop input at once; the next mode mints its own scoped session.
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
    // Capture before noVNC can forward Escape to the desktop.
    window.addEventListener("keydown", releaseOnEscape, true);
    return () => window.removeEventListener("keydown", releaseOnEscape, true);
  }, [changeMode, mode, onModeChange]);

  const statusLabel =
    state === "connected"
      ? mode === "takeover"
        ? "connected · takeover"
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
    >
      <div className={styles.desktopHeader}>
        <div>
          <strong>
            <Monitor size={15} aria-hidden="true" /> {desktopLabel ?? "Desktop stream"}
          </strong>
          <span>{mode === "takeover" ? "You have control" : "Watching"}</span>
        </div>
        <div className={styles.desktopActions}>
          <span className={styles.desktopStatus} aria-live="polite">
            {statusLabel}
          </span>
          {onModeChange ? (
            <Button
              ref={controlButtonRef}
              variant={mode === "takeover" ? "neutral" : "primary"}
              onClick={() => changeMode(mode === "takeover" ? "watch" : "takeover")}
              disabled={mode === "watch" && (!canTakeControl || state !== "connected")}
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
        </div>
      </div>
      <div className={styles.desktopStage} ref={stageRef}>
        {state !== "connected" ? (
          <div className={styles.desktopPlaceholder}>
            {state === "error"
              ? `Desktop stream failed${error ? `: ${error}` : "."}`
              : state === "closed"
                ? "Live session ended. Reconnect to resume watching."
                : "Opening the desktop…"}
          </div>
        ) : null}
      </div>
    </section>
  );
}
