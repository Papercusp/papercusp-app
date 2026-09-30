/**
 * GET /api/deploy/local-desktops → { desktops: [...] }
 *
 * The LOCAL half of the Swarm live view's roster
 * (`agent-virtual-desktops-2026-08-23` P-004). `/deploy/frames` enumerates
 * DEPLOYED frames from the harness registry; this enumerates desktop sessions
 * running on THIS host from the DesktopSession registry (P-003), so a pot's
 * Xvfb lease and a frame slot are as visible to a human as a remote frame is.
 *
 * Why a sibling route rather than more rows in `/deploy/frames`: that response
 * is shaped per-HARNESS (slug + frame handle + a desktop flag) and its consumer
 * opens one SSE stream per slug from it. A local desktop is a per-SESSION thing
 * with no such stream, and several can share one harness. Folding them in would
 * have meant either lying about the shape or teaching the existing consumer to
 * skip rows it must not stream — so they stay two lists that the view joins.
 *
 * Registry-backed and therefore CROSS-PROCESS: a desktop leased by a sibling
 * operator appears here too, which the old `leasedHiveDesktops()` process Map
 * could never do.
 *
 * ⚠ A row here is a RECORD, never a liveness verdict (D-004) — `state` is what
 * its owner last wrote. Reconciliation at operator start is what keeps that
 * honest; a viewer that dials a dead display simply fails to connect.
 *
 * `auth: 'loopback'` with no session gate, matching `/deploy/frames`: the
 * desktop webview is cookie-less and the loopback bind is the perimeter.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  listDesktopSessions,
  type DesktopSessionRecord,
} from '../../../desktop/desktop-session-registry';

/**
 * Registry records → the roster rows the Swarm view consumes. Exported pure so
 * the two filters below are testable without standing up a route: both are
 * silent when wrong (a remote row renders a tile whose VNC session can only
 * fail; an unparseable display renders a tile that cannot be dialled at all).
 */
export function toLocalDesktopRows(sessions: readonly DesktopSessionRecord[]) {
  return sessions
    // Only LOCAL rows: a remote row's display belongs to its own host and is
    // reached over the frame path, not by spawning x11vnc here.
    .filter((s) => s.hostRef === null)
    .map((s) => ({
      id: s.id,
      slug: s.harnessSlug,
      kind: s.kind,
      scope: s.scope,
      scopeRef: s.scopeRef,
      // The bare number is what the VNC route and the tile key want; the raw
      // ':110' string stays available for anything that displays it.
      display: Number(s.display.replace(/^:/, '')),
      displayRaw: s.display,
      displayGeometry: s.displayGeometry,
      captureGeometry: s.captureGeometry,
      state: s.state,
      viewerMode: s.viewerMode,
      viewerActor: s.viewerActor,
      capabilities: s.capabilities,
      lastActiveAt: s.lastActiveAt,
    }))
    // A display that does not parse to a number cannot be VNC'd (x11vnc takes a
    // display number), so it would render a tile that can only fail.
    .filter((d) => Number.isInteger(d.display));
}

export default defineTool({
  method: 'GET',
  path: '/deploy/local-desktops',
  auth: 'loopback',
  async handler() {
    const workspaceId = activeWorkspaceId();
    let sessions;
    try {
      sessions = await listDesktopSessions({ workspaceId, limit: 200 });
    } catch (e) {
      // The tab must degrade to "no local desktops", never to a broken roster:
      // an operator without the registry migration applied still gets its frames.
      return Response.json(
        { desktops: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 200) },
        { status: 200 },
      );
    }
    return Response.json({ desktops: toLocalDesktopRows(sessions) });
  },
});
