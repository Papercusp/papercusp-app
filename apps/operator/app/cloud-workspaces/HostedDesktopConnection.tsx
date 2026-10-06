"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HostedDesktopWorkspace } from "./HostedDesktopWorkspace";
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
import { useDesktopGridState } from "@/app/_components/desktop-grid/use-desktop-grid-state";
import { useVisibleRefresh } from "@/app/_components/desktop-grid/use-visible-refresh";
import {
  DESKTOP_GRID_ROSTER_REFRESH_MS,
  DESKTOP_GRID_THUMBNAIL_REFRESH_MS,
  livePins,
} from "@/app/_components/desktop-grid/desktop-grid-model";

/** One connection owner for both the desktop destination and cloud-management tabs. */
export function HostedDesktopConnection({
  workspace,
  showDesktop = true,
  onWorkspaceBound,
}: {
  workspace: WorkspaceHostControlRow;
  showDesktop?: boolean;
  onWorkspaceBound?: (hostId: string, workspaceId: string | null) => void;
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
      onWorkspaceBound={onWorkspaceBound}
    />
  );
}

function DesktopConnection({
  workspace,
  routeLabel,
  showDesktop,
  onWorkspaceBound,
}: {
  workspace: WorkspaceHostControlRow;
  routeLabel: string | null;
  showDesktop: boolean;
  onWorkspaceBound?: (hostId: string, workspaceId: string | null) => void;
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
  // P-006: which desktop is open, which are pinned live, and the filter are URL state.
  const grid = useDesktopGridState();
  const selectedDesktop = grid.selection;
  const selectionRef = useRef(selectedDesktop);
  selectionRef.current = selectedDesktop;
  const [viewerState, setViewerState] =
    useState<HostedDesktopViewerState | null>(null);
  const [startState, setStartState] = useState<HostedDesktopQueryState>("idle");
  const [startError, setStartError] = useState<string | null>(null);
  /** One automatic start per connection, so a failed start is shown, not retried in a loop. */
  const startRequested = useRef(false);
  const liveIds = useMemo(
    () => new Set(roster.map((entry) => entry.desktopSessionId)),
    [roster],
  );
  const pinned = useMemo(() => livePins(grid.pinned, liveIds), [grid.pinned, liveIds]);

  const onBridgeChange = useCallback(
    (next: HostedWorkspaceDesktopBridge | null) => {
      setBridge(next);
      if (!next) {
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
    if (!showDesktop || !bridge || rosterState !== "ready" || roster.length > 0) return;
    if (startRequested.current) return;
    startRequested.current = bridge.requestStart();
  }, [showDesktop, bridge, roster, rosterState]);
  const { setSelection } = grid;
  const onDesktopStarted = useCallback(
    (desktop: HostedDesktopRosterEntry) => {
      setRoster((current) =>
        current.some((entry) => entry.desktopSessionId === desktop.desktopSessionId)
          ? current
          : [...current, desktop],
      );
      if (!selectionRef.current) {
        setSelection({ desktopSessionId: desktop.desktopSessionId, mode: "watch" });
      }
    },
    [setSelection],
  );
  const onRosterChange = useCallback((next: HostedDesktopRosterEntry[]) => {
    setRoster(next);
    setRosterError(null);
    // Keep the last frame of every desktop still listed: a periodic roster read
    // must not blank the grid until the next thumbnail arrives.
    const listed = new Set(next.map((entry) => entry.desktopSessionId));
    setThumbnails((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => listed.has(id))),
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

  // P-005 / P-006: fresh thumbnails while the grid is on screen, none when it is
  // not. A tile already streaming live (open or pinned) needs no thumbnail.
  const gridVisible = showDesktop && Boolean(bridge);
  useVisibleRefresh(
    () => {
      if (!bridge) return;
      const live = new Set(pinned);
      if (selectedDesktop) live.add(selectedDesktop.desktopSessionId);
      for (const desktop of roster) {
        if (!live.has(desktop.desktopSessionId)) bridge.requestThumbnail(desktop.desktopSessionId);
      }
    },
    DESKTOP_GRID_THUMBNAIL_REFRESH_MS,
    gridVisible && roster.length > 0,
  );
  // A desktop an agent starts later must appear without a manual refresh.
  useVisibleRefresh(
    () => {
      if (bridge && rosterState !== "loading") bridge.requestRoster();
    },
    DESKTOP_GRID_ROSTER_REFRESH_MS,
    gridVisible && rosterState !== "idle",
  );

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
          onSelectDesktop={grid.setSelection}
          onViewerStateChange={setViewerState}
          pinned={pinned}
          onPinnedChange={grid.setPinned}
          filter={grid.filter}
          onFilterChange={grid.setFilter}
        />
      )}
      {routeLabel && (
        <HostedWorkspaceSession
          hostId={workspace.id}
          routeLabel={routeLabel}
          workspaceName={workspace.name}
          onWorkspaceIdChange={setWorkspaceId}
          onWorkspaceBound={id => onWorkspaceBound?.(workspace.id, id)}
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
