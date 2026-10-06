"use client";

import type { ReactNode } from "react";
import { Eye, Monitor, Pin, PinOff, Search } from "lucide-react";
import {
  DESKTOP_GRID_MAX_PINS,
  filterDesktopTiles,
  toggleDesktopPin,
  type DesktopGridTile,
} from "./desktop-grid-model";
import styles from "./desktop-grid.module.css";

export interface DesktopGridProps {
  tiles: readonly DesktopGridTile[];
  /** The desktop open in the large viewer, if any. */
  selectedId: string | null;
  pinned: readonly string[];
  filter: string;
  /** False while the source cannot open a viewer (disconnected, list failed). */
  canOpen: boolean;
  onOpen: (desktopSessionId: string) => void;
  onPinnedChange: (pinned: string[]) => void;
  onFilterChange: (filter: string) => void;
  /** The source's live viewer for a pinned tile (watch mode). */
  renderLive: (tile: DesktopGridTile) => ReactNode;
}

function formatLastActive(value: string | undefined): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Plan agent-multi-desktops-grid P-006 / D-009: every live desktop as a tile —
 * thumbnail, owning agent, work-item, state, last activity. Click opens the large
 * viewer; up to two tiles can be pinned to stream live in place. Source-agnostic:
 * the hosted relay and the local registry both render through this.
 */
export function DesktopGrid({
  tiles,
  selectedId,
  pinned,
  filter,
  canOpen,
  onOpen,
  onPinnedChange,
  onFilterChange,
  renderLive,
}: DesktopGridProps) {
  const visible = filterDesktopTiles(tiles, filter);
  const pinsFull = pinned.length >= DESKTOP_GRID_MAX_PINS;
  return (
    <section className={styles.grid} aria-label="Desktop grid">
      <div className={styles.toolbar}>
        <label className={styles.filter}>
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={filter}
            placeholder="Filter by agent, work-item or state"
            aria-label="Filter desktops"
            onChange={(event) => onFilterChange(event.target.value)}
          />
        </label>
        <span className={styles.count} role="status">
          {tiles.length} {tiles.length === 1 ? "desktop" : "desktops"} · {pinned.length}/
          {DESKTOP_GRID_MAX_PINS} live
        </span>
      </div>
      {tiles.length > 0 && visible.length === 0 ? (
        <p className={styles.noMatch}>No desktops match “{filter.trim()}”.</p>
      ) : null}
      <ul className={styles.tiles} aria-label="Available desktops">
        {visible.map((tile) => {
          const isPinned = pinned.includes(tile.desktopSessionId);
          const isSelected = selectedId === tile.desktopSessionId;
          const lastActive = formatLastActive(tile.lastActiveAt);
          const meta = (
            <span className={styles.meta}>
              <strong className={styles.title}>{tile.title}</strong>
              {tile.ownerLabel ? (
                <span className={styles.owner}>{tile.ownerLabel}</span>
              ) : null}
              {tile.workItemLabel ? (
                <span className={styles.workItem} title={tile.workItemLabel}>
                  {tile.workItemLabel}
                </span>
              ) : null}
              <span className={styles.state}>
                {tile.state}
                {tile.geometry ? ` · ${tile.geometry}` : ""}
                {lastActive && tile.lastActiveAt ? (
                  <>
                    {" · active "}
                    <time dateTime={tile.lastActiveAt}>{lastActive}</time>
                  </>
                ) : null}
              </span>
            </span>
          );
          return (
            <li
              key={tile.desktopSessionId}
              className={styles.tile}
              data-pinned={isPinned}
              data-selected={isSelected}
            >
              {isPinned ? (
                <div className={styles.live} role="group" aria-label={`${tile.title} live`}>
                  {renderLive(tile)}
                  {/* A pinned tile still opens the large viewer (take over lives there). */}
                  <button
                    type="button"
                    className={styles.open}
                    aria-label={`Watch ${tile.title}`}
                    aria-pressed={isSelected}
                    disabled={!canOpen}
                    onClick={() => onOpen(tile.desktopSessionId)}
                  >
                    {meta}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.open}
                  aria-label={`Watch ${tile.title}`}
                  aria-pressed={isSelected}
                  disabled={!canOpen}
                  onClick={() => onOpen(tile.desktopSessionId)}
                >
                  <span className={styles.thumbnail} aria-hidden="true">
                    {tile.thumbnailSrc ? (
                      <img src={tile.thumbnailSrc} alt="" loading="lazy" />
                    ) : (
                      <Monitor size={28} />
                    )}
                  </span>
                  {meta}
                  <span className={styles.watch}>
                    <Eye size={12} aria-hidden="true" /> Watch
                  </span>
                </button>
              )}
              <button
                type="button"
                className={styles.pin}
                aria-label={isPinned ? `Unpin ${tile.title}` : `Pin ${tile.title} live`}
                aria-pressed={isPinned}
                disabled={!canOpen || (!isPinned && pinsFull)}
                onClick={() => onPinnedChange(toggleDesktopPin(pinned, tile.desktopSessionId))}
              >
                {isPinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
