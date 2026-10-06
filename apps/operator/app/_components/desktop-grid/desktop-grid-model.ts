/**
 * The source-agnostic model behind the desktop grid (plan
 * agent-multi-desktops-grid-2026-10-06, D-009): one tile per live desktop, a
 * filter, up to two pinned live tiles, and the selection that opens the large
 * viewer. The hosted relay (cloud) and this operator's registry (local) both map
 * their rows onto `DesktopGridTile`; nothing here knows which one it came from.
 */

export type DesktopGridViewerMode = "watch" | "takeover";

export interface DesktopGridSelection {
  desktopSessionId: string;
  mode: DesktopGridViewerMode;
}

export interface DesktopGridTile {
  desktopSessionId: string;
  /** What the tile is called — the agent's desktop name, else its display. */
  title: string;
  /** Who it belongs to, already phrased for a person ("Agent su-1a2b"). */
  ownerLabel: string | null;
  /** The work-item its owner is on now, e.g. "WI-12 · build the grid". */
  workItemLabel: string | null;
  state: string;
  geometry?: string;
  lastActiveAt?: string;
  /** A ready-to-render image source, or null while none has arrived. */
  thumbnailSrc: string | null;
}

/** D-009: at most two tiles stream live at once; the rest stay thumbnails. */
export const DESKTOP_GRID_MAX_PINS = 2;
/** P-005: how often a visible grid asks for fresh thumbnails. */
export const DESKTOP_GRID_THUMBNAIL_REFRESH_MS = 5_000;
/** How often a visible grid re-reads the roster, so a desktop an agent starts appears. */
export const DESKTOP_GRID_ROSTER_REFRESH_MS = 15_000;

/** Case-insensitive match on everything a tile shows a person. */
export function filterDesktopTiles(
  tiles: readonly DesktopGridTile[],
  query: string,
): DesktopGridTile[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...tiles];
  return tiles.filter((tile) =>
    [tile.title, tile.ownerLabel, tile.workItemLabel, tile.state, tile.desktopSessionId]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(needle)),
  );
}

/**
 * Pin or unpin one tile. Pinning past the limit is refused (the list comes back
 * unchanged) rather than silently evicting a tile someone chose to keep live.
 */
export function toggleDesktopPin(
  pinned: readonly string[],
  desktopSessionId: string,
  max = DESKTOP_GRID_MAX_PINS,
): string[] {
  if (pinned.includes(desktopSessionId)) {
    return pinned.filter((id) => id !== desktopSessionId);
  }
  if (pinned.length >= max) return [...pinned];
  return [...pinned, desktopSessionId];
}

/** Pins that still name a live desktop, capped at the limit. */
export function livePins(
  pinned: readonly string[],
  liveIds: ReadonlySet<string>,
  max = DESKTOP_GRID_MAX_PINS,
): string[] {
  return [...new Set(pinned)].filter((id) => liveIds.has(id)).slice(0, max);
}

/** The URL form of a selection: `watch:<id>` or `takeover:<id>`. */
export function serializeDesktopSelection(
  selection: DesktopGridSelection | null,
): string | null {
  return selection ? `${selection.mode}:${selection.desktopSessionId}` : null;
}

export function parseDesktopSelection(
  value: string | null | undefined,
): DesktopGridSelection | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const mode = value.slice(0, separator);
  const desktopSessionId = value.slice(separator + 1);
  if ((mode !== "watch" && mode !== "takeover") || !desktopSessionId) return null;
  return { desktopSessionId, mode };
}
