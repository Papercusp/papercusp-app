/**
 * The "This computer" source of the desktops grid (plan
 * agent-multi-desktops-grid-2026-10-06, P-007 / D-009 / D-015): this operator's own
 * agent desktops, read from the DesktopSession registry through the `desktops.local`
 * sync query, mapped onto the same source-agnostic tile the cloud relay uses.
 *
 * Pure, so the mapping and the session handshake are testable without a viewer.
 */
import type { LocalDesktopRow } from "@papercusp/operator-core/lib/endpoint-route/routes/deploy/local-desktops";
import type {
  DesktopGridTile,
  DesktopGridViewerMode,
} from "@/app/_components/desktop-grid/desktop-grid-model";

/** The sync query behind the local grid (operator-core sync-resolver). */
export const LOCAL_DESKTOPS_QUERY = "desktops.local";

/** The `desktopHost` URL value that selects this computer on the Desktops page. */
export const LOCAL_DESKTOP_HOST = "local";

/** A `LocalDesktopRow` as it arrives over JSON: its `Date` is an ISO string. */
export type LocalDesktopSyncRow = Omit<LocalDesktopRow, "lastActiveAt"> & {
  lastActiveAt: string | null;
};

function geometryLabel(row: LocalDesktopSyncRow): string | undefined {
  const geometry = row.displayGeometry;
  if (!geometry || !geometry.width || !geometry.height) return undefined;
  return `${geometry.width}×${geometry.height}`;
}

/** What a person calls this desktop: the agent's name for it, else its display. */
export function localDesktopTitle(row: LocalDesktopSyncRow): string {
  return row.name ?? `Display ${row.displayRaw}`;
}

function ownerLabel(row: LocalDesktopSyncRow): string | null {
  // The hosted mapper's phrasing (HostedDesktopWorkspace), so one agent reads the
  // same on both sources.
  if (row.owner) return row.scope === "pot" ? `Pot ${row.owner}` : `Agent ${row.owner}`;
  return row.slug ? `Harness ${row.slug}` : null;
}

/** One registry row → one grid tile (D-009). */
export function localDesktopTile(
  row: LocalDesktopSyncRow,
  thumbnailSrc: string | null,
): DesktopGridTile {
  const geometry = geometryLabel(row);
  return {
    desktopSessionId: row.id,
    title: localDesktopTitle(row),
    ownerLabel: ownerLabel(row),
    workItemLabel: row.workItemId
      ? row.workItemIntent
        ? `${row.workItemId} · ${row.workItemIntent}`
        : row.workItemId
      : null,
    state: row.state,
    ...(geometry ? { geometry } : {}),
    ...(row.lastActiveAt ? { lastActiveAt: row.lastActiveAt } : {}),
    thumbnailSrc,
  };
}

/** P-005: one fresh JPEG of a local desktop, or 204 when there is none. */
export function localDesktopThumbnailUrl(desktopSessionId: string): string {
  return `/api/deploy/local-desktops/${encodeURIComponent(desktopSessionId)}/thumbnail`;
}

export type LocalDesktopRfb = "kasmvnc" | "standard";

export interface LocalVncSession {
  wsUrl: string;
  rfb: LocalDesktopRfb;
}

export interface LocalVncSessionRequest {
  /** The harness the desktop belongs to; the server re-derives it from the registry. */
  slug: string | null;
  display: number;
  /** The registry row the viewer means — the minted session must name the same one. */
  desktopSessionId: string;
  mode: DesktopGridViewerMode;
}

/**
 * Mint a single-use, audited VNC session for a local desktop and say which RFB class
 * speaks to it (D-015). The bridge refuses a display no agent desktop registered.
 *
 * A session minted for a DIFFERENT registry row than the one asked for is refused:
 * a display number is reused once its desktop is gone, and a viewer must never show
 * someone else's screen under the tile it was opened from.
 */
export async function requestLocalVncSession(
  request: LocalVncSessionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalVncSession> {
  const slug = request.slug ?? "workspace";
  const response = await fetchImpl(`/api/deploy/${encodeURIComponent(slug)}/vnc-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ display: request.display, mode: request.mode, target: "local" }),
  });
  let payload: {
    ok?: boolean;
    wsUrl?: string;
    error?: string;
    desktopSessionId?: string | null;
    rfb?: string;
  } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    // Fall through to the status-based error below.
  }
  if (!response.ok || !payload.ok || !payload.wsUrl) {
    throw new Error(payload.error ?? `vnc-session HTTP ${response.status}`);
  }
  if (payload.desktopSessionId && payload.desktopSessionId !== request.desktopSessionId) {
    throw new Error("desktop_changed: this display now belongs to another desktop");
  }
  return {
    wsUrl: payload.wsUrl,
    rfb: payload.rfb === "kasmvnc" ? "kasmvnc" : "standard",
  };
}
