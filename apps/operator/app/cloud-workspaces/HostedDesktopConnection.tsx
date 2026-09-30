"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  HostedDesktopWorkspace,
  type DesktopSelection,
} from "./HostedDesktopWorkspace";
import type { HostedDesktopViewerState } from "./HostedDesktopViewer";
import {
  HostedWorkspaceSession,
  type HostedDesktopOperation,
  type HostedDesktopQueryState,
  type HostedWorkspaceDesktopBridge,
} from "./HostedWorkspaceSession";
import type {
  HostedDesktopRosterEntry,
  HostedDesktopThumbnailResult,
} from "./hosted-desktop-viewer-protocol";
import { readHostedWorkspaceConnector } from "./hosted-workspace-session-protocol";
import type { WorkspaceHostControlRow } from "./workspace-view-model";

/** One connection owner for both the desktop destination and cloud-management tabs. */
export function HostedDesktopConnection({
  workspace,
  showDesktop = true,
}: {
  workspace: WorkspaceHostControlRow;
  showDesktop?: boolean;
}) {
  const routeLabel =
    readHostedWorkspaceConnector(workspace.tunnel)?.routeLabel ?? null;
  // A different host/connector must never inherit the previous session's identity or media.
  return (
    <DesktopConnection
      key={`${workspace.id}:${routeLabel ?? ""}`}
      workspace={workspace}
      routeLabel={routeLabel}
      showDesktop={showDesktop}
    />
  );
}

function DesktopConnection({
  workspace,
  routeLabel,
  showDesktop,
}: {
  workspace: WorkspaceHostControlRow;
  routeLabel: string | null;
  showDesktop: boolean;
}) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [bridge, setBridge] = useState<HostedWorkspaceDesktopBridge | null>(
    null,
  );
  const [roster, setRoster] = useState<HostedDesktopRosterEntry[]>([]);
  const [rosterState, setRosterState] =
    useState<HostedDesktopQueryState>("idle");
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [thumbnails, setThumbnails] = useState<
    Readonly<Record<string, HostedDesktopThumbnailResult>>
  >({});
  const [selectedDesktop, setSelectedDesktop] =
    useState<DesktopSelection | null>(null);
  const [viewerState, setViewerState] =
    useState<HostedDesktopViewerState | null>(null);
  const [startState, setStartState] = useState<HostedDesktopQueryState>("idle");
  const [startError, setStartError] = useState<string | null>(null);
  const requestedThumbnails = useRef(new Set<string>());
  /** One automatic start per connection, so a failed start is shown, not retried in a loop. */
  const startRequested = useRef(false);

  const onBridgeChange = useCallback(
    (next: HostedWorkspaceDesktopBridge | null) => {
      setBridge(next);
      if (!next) {
        requestedThumbnails.current.clear();
        setThumbnails({});
        startRequested.current = false;
        setStartState("idle");
        setStartError(null);
      }
    },
    [],
  );
  // D-405: a new machine runs no desktop until someone opens one. Opening this
  // page IS that ask, so an empty roster starts the workspace desktop and opens it.
  useEffect(() => {
    if (!bridge || rosterState !== "ready" || roster.length > 0) return;
    if (startRequested.current) return;
    startRequested.current = bridge.requestStart();
  }, [bridge, roster, rosterState]);
  const onDesktopStarted = useCallback((desktop: HostedDesktopRosterEntry) => {
    setRoster((current) =>
      current.some((entry) => entry.desktopSessionId === desktop.desktopSessionId)
        ? current
        : [...current, desktop],
    );
    setSelectedDesktop(
      (current) =>
        current ?? { desktopSessionId: desktop.desktopSessionId, mode: "watch" },
    );
  }, []);
  const onRosterChange = useCallback((next: HostedDesktopRosterEntry[]) => {
    setRoster(next);
    setRosterError(null);
    setThumbnails({});
    requestedThumbnails.current.clear();
    setSelectedDesktop((current) =>
      current &&
      next.some((entry) => entry.desktopSessionId === current.desktopSessionId)
        ? current
        : null,
    );
  }, []);
  const onThumbnailChange = useCallback(
    (result: HostedDesktopThumbnailResult) => {
      setThumbnails((current) => ({
        ...current,
        [result.desktopSessionId]: result,
      }));
    },
    [],
  );
  const onQueryStateChange = useCallback(
    (
      state: HostedDesktopQueryState,
      operation?: HostedDesktopOperation,
      code?: string,
    ) => {
      if (operation === "start") {
        setStartState(state);
        setStartError(state === "error" ? (code ?? "desktop_start_failed") : null);
        return;
      }
      if (
        operation === "roster" ||
        (operation === undefined && state === "idle")
      )
        setRosterState(state);
      if (state === "error" && operation === "roster")
        setRosterError(code ?? "desktop_roster_failed");
      else if (state !== "error" && operation === "roster")
        setRosterError(null);
    },
    [],
  );
  useEffect(() => {
    if (!bridge) return;
    for (const desktop of roster) {
      if (requestedThumbnails.current.has(desktop.desktopSessionId)) continue;
      requestedThumbnails.current.add(desktop.desktopSessionId);
      bridge.requestThumbnail(desktop.desktopSessionId);
    }
  }, [bridge, roster]);

  return (
    <>
      {showDesktop && (
        <HostedDesktopWorkspace
          hostName={workspace.name}
          workspaceId={workspaceId}
          hostId={workspace.id}
          routeLabel={routeLabel}
          bridge={bridge}
          roster={roster}
          rosterState={rosterState}
          rosterError={rosterError}
          startState={startState}
          startError={startError}
          thumbnails={thumbnails}
          selectedDesktop={selectedDesktop}
          viewerState={viewerState}
          onSelectDesktop={setSelectedDesktop}
          onViewerStateChange={setViewerState}
        />
      )}
      {routeLabel && (
        <HostedWorkspaceSession
          hostId={workspace.id}
          routeLabel={routeLabel}
          workspaceName={workspace.name}
          onWorkspaceIdChange={setWorkspaceId}
          onDesktopBridgeChange={onBridgeChange}
          onDesktopRosterChange={onRosterChange}
          onDesktopThumbnailChange={onThumbnailChange}
          onDesktopStarted={onDesktopStarted}
          onDesktopQueryStateChange={onQueryStateChange}
        />
      )}
    </>
  );
}
