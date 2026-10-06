"use client";

import { Monitor, RefreshCw } from "lucide-react";
import { Button } from "@/app/harness/Button";
import {
  HostedDesktopViewer,
  type HostedDesktopViewerState,
} from "./HostedDesktopViewer";
import type {
  HostedDesktopQueryState,
  HostedWorkspaceDesktopBridge,
} from "./HostedWorkspaceSession";
import type {
  HostedDesktopRosterEntry,
  HostedDesktopThumbnailResult,
  HostedDesktopViewerMode,
} from "./hosted-desktop-viewer-protocol";
import { formatTimestamp } from "./workspace-view-model";
import { DesktopGrid } from "@/app/_components/desktop-grid/DesktopGrid";
import type { DesktopGridTile } from "@/app/_components/desktop-grid/desktop-grid-model";
import styles from "./hosted-workspace-session.module.css";

export type DesktopSelection = {
  desktopSessionId: string;
  mode: HostedDesktopViewerMode;
};

export interface HostedDesktopWorkspaceProps {
  hostName: string;
  workspaceId: string | null;
  hostId: string;
  routeLabel: string | null;
  bridge: HostedWorkspaceDesktopBridge | null;
  roster: readonly HostedDesktopRosterEntry[];
  rosterState: HostedDesktopQueryState;
  rosterError: string | null;
  /** The automatic desktop start of D-405, for a workspace with none running. */
  startState: HostedDesktopQueryState;
  startError: string | null;
  thumbnails: Readonly<Record<string, HostedDesktopThumbnailResult>>;
  selectedDesktop: DesktopSelection | null;
  viewerState: HostedDesktopViewerState | null;
  onSelectDesktop: (selection: DesktopSelection | null) => void;
  onViewerStateChange: (state: HostedDesktopViewerState) => void;
  /** P-006: tiles streaming live in place (≤ 2) and the tile filter — URL state. */
  pinned: readonly string[];
  onPinnedChange: (pinned: string[]) => void;
  filter: string;
  onFilterChange: (filter: string) => void;
}

function desktopLabel(entry: HostedDesktopRosterEntry): string {
  if (entry.name) return entry.name;
  return entry.displayNumber !== undefined
    ? `Display ${entry.displayNumber}`
    : entry.desktopSessionId;
}

function ownerLabel(entry: HostedDesktopRosterEntry): string | null {
  if (!entry.owner) return entry.scope === "workspace" ? "Workspace desktop" : null;
  return entry.scope === "pot" ? `Pot ${entry.owner}` : `Agent ${entry.owner}`;
}

/** Map one relay roster row onto the source-agnostic grid tile (D-009). */
export function hostedDesktopTile(
  entry: HostedDesktopRosterEntry,
  thumbnail: HostedDesktopThumbnailResult | undefined,
): DesktopGridTile {
  return {
    desktopSessionId: entry.desktopSessionId,
    title: desktopLabel(entry),
    ownerLabel: ownerLabel(entry),
    workItemLabel: entry.workItemId
      ? entry.workItemIntent
        ? `${entry.workItemId} · ${entry.workItemIntent}`
        : entry.workItemId
      : null,
    state: entry.state,
    ...(entry.geometry ? { geometry: entry.geometry } : {}),
    ...(entry.lastActiveAt ? { lastActiveAt: entry.lastActiveAt } : {}),
    thumbnailSrc: thumbnail?.data ? `data:image/jpeg;base64,${thumbnail.data}` : null,
  };
}

/** D-062: one large desktop, with authenticated discovery and activity alongside. */
export function HostedDesktopWorkspace({
  hostName,
  workspaceId,
  hostId,
  routeLabel,
  bridge,
  roster,
  rosterState,
  rosterError,
  startState,
  startError,
  thumbnails,
  selectedDesktop,
  viewerState,
  onSelectDesktop,
  onViewerStateChange,
  pinned,
  onPinnedChange,
  filter,
  onFilterChange,
}: HostedDesktopWorkspaceProps) {
  const selectedEntry = roster.find(
    (entry) => entry.desktopSessionId === selectedDesktop?.desktopSessionId,
  );
  const canOpenViewer = Boolean(
    workspaceId && routeLabel && bridge && rosterState !== "error",
  );
  const recentActivity = roster
    .filter(
      (entry) =>
        entry.lastActiveAt && Number.isFinite(Date.parse(entry.lastActiveAt)),
    )
    .toSorted(
      (a, b) => Date.parse(b.lastActiveAt!) - Date.parse(a.lastActiveAt!),
    );
  const connectionLabel =
    rosterState === "error"
      ? "Desktop list unavailable"
      : !bridge
        ? "Workspace disconnected"
        : rosterState === "loading"
          ? "Refreshing desktops…"
          : "Workspace connected";

  let emptyTitle = "Choose a desktop to watch";
  let emptyDescription =
    "Select a desktop from the list. You can take control once the live screen opens.";
  if (!routeLabel) {
    emptyTitle = "Your desktop is not ready yet";
    emptyDescription =
      "The desktop will appear here after workspace setup completes.";
  } else if (!bridge) {
    emptyTitle = "Connect your workspace";
    emptyDescription =
      "Connect the Browser workspace session below to discover its desktops.";
  } else if (rosterState === "error") {
    emptyTitle = "Desktops could not be loaded";
    emptyDescription =
      "Your workspace may still be running. Refresh the desktop list to try again.";
  } else if (rosterState === "loading" && roster.length === 0) {
    emptyTitle = "Finding your desktops…";
    emptyDescription =
      "Waiting for the workspace to report its available screens.";
  } else if (roster.length === 0 && startState === "loading") {
    emptyTitle = "Starting your desktop…";
    emptyDescription =
      "Your workspace is starting its desktop. This takes up to about 20 seconds.";
  } else if (roster.length === 0 && startState === "error") {
    emptyTitle = "Your desktop could not be started";
    emptyDescription =
      startError === "controller_required"
        ? "Another tab controls this workspace. Start the desktop from that tab."
        : "Refresh the desktop list to try again.";
  } else if (roster.length === 0) {
    emptyTitle = "No desktops are available yet";
    emptyDescription =
      "A desktop will appear here when one is started in this workspace.";
  } else if (selectedDesktop && !selectedEntry) {
    emptyTitle = "This desktop is no longer available";
    emptyDescription = "Choose another desktop or refresh the list.";
  }

  return (
    <section
      className={styles.desktopSurface}
      aria-label={`Desktops for ${hostName}`}
      data-roster-state={rosterState}
    >
      <div className={styles.desktopSurfaceHeader}>
        <div>
          <h3>
            <Monitor size={18} aria-hidden="true" /> {hostName}
          </h3>
          <p>Watch your desktops and step in when you need to.</p>
        </div>
        <span
          className={styles.desktopConnection}
          data-connected={Boolean(bridge)}
          role="status"
        >
          {connectionLabel}
        </span>
      </div>
      {rosterError ? (
        <p className={styles.desktopRosterError} role="alert">
          Desktop list unavailable: {rosterError}
        </p>
      ) : null}
      <div className={styles.desktopWorkspaceLayout}>
        <div className={styles.desktopWorkspaceMain}>
          {selectedDesktop && selectedEntry && workspaceId && routeLabel ? (
            <div className={styles.desktopViewerMount}>
              <HostedDesktopViewer
                key={selectedDesktop.desktopSessionId}
                workspaceId={workspaceId}
                hostId={hostId}
                routeLabel={routeLabel}
                desktopSessionId={selectedDesktop.desktopSessionId}
                desktopLabel={desktopLabel(selectedEntry)}
                mode={selectedDesktop.mode}
                canTakeControl={canOpenViewer}
                onModeChange={(mode) =>
                  onSelectDesktop({
                    desktopSessionId: selectedDesktop.desktopSessionId,
                    mode,
                  })
                }
                onStateChange={onViewerStateChange}
              />
              <div className={styles.desktopRosterToolbar}>
                <span aria-live="polite">
                  {viewerState
                    ? `Desktop stream: ${viewerState}`
                    : "Opening desktop…"}
                </span>
                <Button
                  variant="ghost"
                  onClick={() => onSelectDesktop(null)}
                  aria-label="Close desktop viewer"
                >
                  Close viewer
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.desktopWorkspaceEmpty} role="status">
              <Monitor size={36} aria-hidden="true" />
              <h4>{emptyTitle}</h4>
              <p>{emptyDescription}</p>
            </div>
          )}
        </div>
        <aside
          className={styles.desktopSidebar}
          aria-label="Workspace desktops and activity"
        >
          <div className={styles.desktopSidebarHeader}>
            <div>
              <h4>In this workspace</h4>
              <p>
                {roster.length} {roster.length === 1 ? "desktop" : "desktops"} ·
                select to watch
              </p>
            </div>
            <Button
              variant="ghost"
              onClick={() => bridge?.requestRoster()}
              disabled={!bridge || rosterState === "loading"}
              aria-label="Refresh desktop roster"
              title="Refresh desktops"
            >
              <RefreshCw size={14} aria-hidden="true" />
            </Button>
          </div>
          {roster.length === 0 ? (
            <p className={styles.desktopRosterEmpty}>
              {rosterState === "loading"
                ? "Loading desktops…"
                : "No desktops reported."}
            </p>
          ) : null}
          <section
            className={styles.desktopActivity}
            aria-label="Recent desktop activity"
          >
            <h4>What's happening</h4>
            {recentActivity.length > 0 ? (
              <ol>
                {recentActivity.map((entry) => (
                  <li key={entry.desktopSessionId}>
                    <strong>
                      {desktopLabel(entry)} · {entry.state}
                    </strong>
                    <span>
                      Last active{" "}
                      <time dateTime={entry.lastActiveAt}>
                        {formatTimestamp(entry.lastActiveAt)}
                      </time>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No desktop activity has been reported yet.</p>
            )}
          </section>
          <p className={styles.desktopControlHint}>
            You can step in at any time. Take control to use an app, then
            release control or press Escape to return to watching.
          </p>
        </aside>
      </div>
      {roster.length > 0 ? (
        <DesktopGrid
          tiles={roster.map((entry) =>
            hostedDesktopTile(entry, thumbnails[entry.desktopSessionId]),
          )}
          selectedId={selectedEntry?.desktopSessionId ?? null}
          pinned={pinned}
          filter={filter}
          canOpen={canOpenViewer}
          onOpen={(desktopSessionId) =>
            onSelectDesktop({ desktopSessionId, mode: "watch" })
          }
          onPinnedChange={onPinnedChange}
          onFilterChange={onFilterChange}
          renderLive={(tile) =>
            workspaceId && routeLabel ? (
              <HostedDesktopViewer
                key={`pin:${tile.desktopSessionId}`}
                workspaceId={workspaceId}
                hostId={hostId}
                routeLabel={routeLabel}
                desktopSessionId={tile.desktopSessionId}
                desktopLabel={tile.title}
                mode="watch"
                // A pinned tile only watches; take over from the large viewer.
                canTakeControl={false}
                onStateChange={() => {}}
              />
            ) : null
          }
        />
      ) : null}
    </section>
  );
}
