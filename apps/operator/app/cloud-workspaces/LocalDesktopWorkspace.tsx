"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Laptop, Monitor, RefreshCw } from "lucide-react";
import { useSyncQuery } from "@papercusp/sync";
import { Button } from "@/app/harness/Button";
import { DesktopGrid } from "@/app/_components/desktop-grid/DesktopGrid";
import {
  DESKTOP_GRID_ROSTER_REFRESH_MS,
  DESKTOP_GRID_THUMBNAIL_REFRESH_MS,
  livePins,
} from "@/app/_components/desktop-grid/desktop-grid-model";
import { useDesktopGridState } from "@/app/_components/desktop-grid/use-desktop-grid-state";
import { useVisibleRefresh } from "@/app/_components/desktop-grid/use-visible-refresh";
import { LocalDesktopViewer, type LocalDesktopViewerState } from "./LocalDesktopViewer";
import {
  LOCAL_DESKTOPS_QUERY,
  localDesktopThumbnailUrl,
  localDesktopTile,
  localDesktopTitle,
  type LocalDesktopSyncRow,
} from "./local-desktop-protocol";
import styles from "./hosted-workspace-session.module.css";

/**
 * Keep each desktop's newest frame as an object URL. A miss (204, failure) keeps the
 * last good frame, so a tile does not blink to an icon between captures; a desktop
 * that leaves the roster has its URL revoked.
 */
function useLocalThumbnails(
  rows: readonly LocalDesktopSyncRow[],
  liveIds: ReadonlySet<string>,
  enabled: boolean,
  fetchImpl: typeof fetch | undefined,
): Readonly<Record<string, string>> {
  const [thumbnails, setThumbnails] = useState<Readonly<Record<string, string>>>({});
  const urlsRef = useRef<Record<string, string>>({});
  const inflight = useRef(new Set<string>());

  const listedKey = rows.map((row) => row.id).join(",");
  useEffect(() => {
    const listed = new Set(listedKey ? listedKey.split(",") : []);
    const urls = urlsRef.current;
    let changed = false;
    for (const id of Object.keys(urls)) {
      if (listed.has(id)) continue;
      URL.revokeObjectURL(urls[id]!);
      delete urls[id];
      changed = true;
    }
    if (changed) setThumbnails({ ...urls });
  }, [listedKey]);

  useEffect(
    () => () => {
      for (const url of Object.values(urlsRef.current)) URL.revokeObjectURL(url);
      urlsRef.current = {};
    },
    [],
  );

  useVisibleRefresh(
    () => {
      const doFetch = fetchImpl ?? fetch;
      for (const row of rows) {
        // A tile already streaming live (open or pinned) needs no thumbnail.
        if (liveIds.has(row.id) || inflight.current.has(row.id)) continue;
        inflight.current.add(row.id);
        void doFetch(localDesktopThumbnailUrl(row.id), { cache: "no-store" })
          .then(async (response) => {
            if (response.status !== 200) return;
            const blob = await response.blob();
            if (blob.size === 0) return;
            const next = URL.createObjectURL(blob);
            const previous = urlsRef.current[row.id];
            urlsRef.current[row.id] = next;
            if (previous) URL.revokeObjectURL(previous);
            setThumbnails({ ...urlsRef.current });
          })
          .catch(() => {
            // Keep the last frame; the next tick tries again.
          })
          .finally(() => inflight.current.delete(row.id));
      }
    },
    DESKTOP_GRID_THUMBNAIL_REFRESH_MS,
    enabled && rows.length > 0,
  );

  return thumbnails;
}

export interface LocalDesktopWorkspaceProps {
  /** Test seam for the thumbnail and session requests. */
  fetchImpl?: typeof fetch;
}

/**
 * "This computer" on the Desktops page (plan agent-multi-desktops-grid P-007): every
 * agent desktop running on this machine in the same grid the cloud workspaces use —
 * thumbnails, owning agent, work-item, state; click to watch, take control from the
 * large viewer, pin up to two to stream live. The roster is the `desktops.local` sync
 * query, which the desktop registry announces on every roster-visible write.
 */
export function LocalDesktopWorkspace({ fetchImpl }: LocalDesktopWorkspaceProps) {
  const roster = useSyncQuery<LocalDesktopSyncRow>({ queryName: LOCAL_DESKTOPS_QUERY });
  const rows = useMemo(() => roster.data ?? [], [roster.data]);
  const grid = useDesktopGridState();
  const [viewerState, setViewerState] = useState<LocalDesktopViewerState | null>(null);

  const ids = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const pinned = useMemo(() => livePins(grid.pinned, ids), [grid.pinned, ids]);
  const selection = grid.selection;
  const selectedRow = selection
    ? rows.find((row) => row.id === selection.desktopSessionId)
    : undefined;
  const liveIds = useMemo(() => {
    const live = new Set(pinned);
    if (selectedRow) live.add(selectedRow.id);
    return live;
  }, [pinned, selectedRow]);

  const thumbnails = useLocalThumbnails(rows, liveIds, !roster.error, fetchImpl);

  // A claim can change with no registry write, so a visible grid re-reads its labels.
  const { invalidate } = roster;
  const refreshRoster = useCallback(() => void invalidate?.(), [invalidate]);
  useVisibleRefresh(refreshRoster, DESKTOP_GRID_ROSTER_REFRESH_MS, !roster.loading);

  const canOpen = !roster.error;

  let emptyTitle = "Choose a desktop to watch";
  let emptyDescription =
    "Select a desktop below. You can take control once the live screen opens.";
  if (roster.loading) {
    emptyTitle = "Finding this computer's desktops…";
    emptyDescription = "Reading the desktops agents have started here.";
  } else if (roster.error) {
    emptyTitle = "Desktops could not be loaded";
    emptyDescription = roster.error.message;
  } else if (rows.length === 0) {
    emptyTitle = "No agent desktops on this computer";
    emptyDescription =
      "An agent's desktop appears here as soon as it starts one with computer:provision_desktop.";
  } else if (selection && !selectedRow) {
    emptyTitle = "This desktop is no longer available";
    emptyDescription = "Choose another desktop below.";
  }

  return (
    <section
      className={styles.desktopSurface}
      aria-label="Desktops on this computer"
      data-roster-state={roster.loading ? "loading" : roster.error ? "error" : "ready"}
    >
      <div className={styles.desktopSurfaceHeader}>
        <div>
          <h3>
            <Laptop size={18} aria-hidden="true" /> This computer
          </h3>
          <p>Watch the desktops your agents are using here and step in when you need to.</p>
        </div>
        <Button
          variant="ghost"
          onClick={refreshRoster}
          disabled={roster.loading || roster.fetching}
          aria-label="Refresh this computer's desktops"
          title="Refresh desktops"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </Button>
      </div>
      <div className={styles.desktopWorkspaceMain}>
        {selection && selectedRow ? (
          <div className={styles.desktopViewerMount}>
            <LocalDesktopViewer
              key={`${selectedRow.id}:${selection.mode}`}
              slug={selectedRow.slug}
              display={selectedRow.display}
              desktopSessionId={selectedRow.id}
              desktopLabel={localDesktopTitle(selectedRow)}
              mode={selection.mode}
              canTakeControl={canOpen}
              onModeChange={(mode) =>
                grid.setSelection({ desktopSessionId: selectedRow.id, mode })
              }
              onStateChange={setViewerState}
              fetchImpl={fetchImpl}
            />
            <div className={styles.desktopRosterToolbar}>
              <span aria-live="polite">
                {viewerState ? `Desktop stream: ${viewerState}` : "Opening desktop…"}
              </span>
              <Button
                variant="ghost"
                onClick={() => grid.setSelection(null)}
                aria-label="Close desktop viewer"
              >
                Close viewer
              </Button>
            </div>
          </div>
        ) : (
          <div
            className={styles.desktopWorkspaceEmpty}
            role={roster.error ? "alert" : "status"}
          >
            <Monitor size={36} aria-hidden="true" />
            <h4>{emptyTitle}</h4>
            <p>{emptyDescription}</p>
          </div>
        )}
      </div>
      {rows.length > 0 ? (
        <DesktopGrid
          tiles={rows.map((row) => localDesktopTile(row, thumbnails[row.id] ?? null))}
          selectedId={selectedRow?.id ?? null}
          pinned={pinned}
          filter={grid.filter}
          canOpen={canOpen}
          onOpen={(desktopSessionId) => grid.setSelection({ desktopSessionId, mode: "watch" })}
          onPinnedChange={grid.setPinned}
          onFilterChange={grid.setFilter}
          renderLive={(tile) => {
            const row = rows.find((candidate) => candidate.id === tile.desktopSessionId);
            return row ? (
              <LocalDesktopViewer
                key={`pin:${row.id}`}
                slug={row.slug}
                display={row.display}
                desktopSessionId={row.id}
                desktopLabel={tile.title}
                mode="watch"
                // A pinned tile only watches; take over from the large viewer.
                canTakeControl={false}
                fetchImpl={fetchImpl}
              />
            ) : null;
          }}
        />
      ) : null}
    </section>
  );
}
