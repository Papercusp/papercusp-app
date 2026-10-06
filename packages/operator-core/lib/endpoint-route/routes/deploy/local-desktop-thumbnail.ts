/**
 * GET /api/deploy/local-desktops/:id/thumbnail → image/jpeg | 204
 *
 * One fresh frame of a LOCAL agent desktop for the desktops grid's "This computer"
 * source (plan agent-multi-desktops-grid-2026-10-06, P-005 / D-008 / D-009). The grid
 * polls this every ~5s per visible tile; the process-wide thumbnailer caches a frame
 * for 4s and coalesces concurrent reads, so a tile is never more than ~10s stale and
 * a closed grid costs nothing (no timer runs when nobody asks — parent D-035).
 *
 * ⚠ SECURITY BOUNDARY, the same one `resolveLocalDesktopByDisplay` documents: this
 * host also runs the owner's real session on :0/:1, so a display number is only ever
 * taken from a REGISTERED, non-terminal, LOCAL (`hostRef === null`) desktop row. A
 * caller names a desktop session id, never a display.
 *
 * 204 (not 404) for "no frame": an unknown id, a remote row, a frozen desktop (a
 * frozen Xvfb cannot answer x11grab, so grabbing would only burn the 5s timeout) and a
 * failed grab all render the same "no recent frame" tile. The reason rides in the
 * `x-desktop-thumbnail` header for diagnosis.
 *
 * `auth: 'loopback'` with no session gate, matching `/deploy/local-desktops`: the
 * desktop webview is cookie-less and the loopback bind is the perimeter.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getDesktopSession, type DesktopSessionRecord } from '../../../desktop/desktop-session-registry';
import { desktopThumbnailer } from '../../../desktop/desktop-thumbnail';

export type LocalThumbnailMiss = 'unknown' | 'remote' | 'frozen' | 'bad-display' | 'no-frame';

export type LocalThumbnailResult = { jpeg: Buffer } | { miss: LocalThumbnailMiss };

export interface LocalThumbnailDeps {
  getSession: (id: string) => Promise<DesktopSessionRecord | undefined>;
  thumbnail: (display: number) => Promise<Buffer | null>;
}

/** Resolve id → registered local display → one frame. Pure over its deps so the
 *  boundary (which rows may be grabbed at all) is unit-testable without a route. */
export async function localDesktopThumbnail(id: string, deps: LocalThumbnailDeps): Promise<LocalThumbnailResult> {
  const session = await deps.getSession(id);
  if (!session) return { miss: 'unknown' };
  if (session.hostRef !== null) return { miss: 'remote' };
  if (session.state === 'frozen') return { miss: 'frozen' };
  const display = Number(session.display.replace(/^:/, ''));
  if (!Number.isInteger(display) || display < 0) return { miss: 'bad-display' };
  const jpeg = await deps.thumbnail(display);
  return jpeg ? { jpeg } : { miss: 'no-frame' };
}

export default defineTool({
  method: 'GET',
  path: '/deploy/local-desktops/:id/thumbnail',
  auth: 'loopback',
  async handler(_req, ctx) {
    const id = ctx.params.id as string;
    const workspaceId = activeWorkspaceId();
    const result = await localDesktopThumbnail(id, {
      getSession: (sessionId) => getDesktopSession({ workspaceId, id: sessionId }),
      thumbnail: (display) => desktopThumbnailer().thumbnail(display),
    });
    if ('miss' in result) {
      return new Response(null, { status: 204, headers: { 'x-desktop-thumbnail': result.miss, 'cache-control': 'no-store' } });
    }
    return new Response(new Uint8Array(result.jpeg), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' },
    });
  },
});
