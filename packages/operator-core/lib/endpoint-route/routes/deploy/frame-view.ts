/**
 * GET /api/deploy/:slug/frame-view → text/event-stream
 *
 * SSE stream of a deployed frame's per-display desktop thumbnails — the Swarm
 * live-view transport (`hive-frame-desktops-live-view-2026-06-06` P-005/P-006,
 * D-003): the operator pulls JPEGs from the frame over SSH ONLY while ≥1 of
 * these streams is open, and fans out here. Events:
 *   `thumb`  — { slug, display, jpegBase64, capturedAtMs, role?, leaseSinceMs? }
 *   `status` — { slug, state: polling|no-frame|error, frameId?, host?, displays?, error? }
 *
 * `auth: 'loopback'` (auth-tier Wave 1) with NO session gate — the desktop webview is cookie-less
 * (loopback bind is the perimeter; see auth.ts header + auth/me's default-user
 * fallback). A strict getSessionUser gate here 401'd every stream in the
 * shipping desktop and blanked the Frames tab.
 */
import { sseResponse } from '@papercusp/sse';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  subscribeFrameView,
  type FrameThumb,
  type FrameViewStatus,
} from '../../../deployment/frame-view';

type FrameViewVocabulary = {
  thumb: FrameThumb;
  status: FrameViewStatus;
};

export default defineTool({
  method: 'GET',
  path: '/deploy/:slug/frame-view',
  auth: 'loopback',
  // Long-lived SSE — exempt from the route-stack watchdog (EI-110: the 30s
  // default 408'd healthy streams).
  timeoutSec: null,
  // SSE — one route-stack run per long-lived connection; don't sample it.
  sampleRate: 0,
  async handler(req, ctx) {
    // Belt-and-braces (security review 2026-06-07): this stream carries live
    // agent-desktop pixels — assert the loopback perimeter in-handler so a
    // listener-bind misconfiguration can never expose it off-box. Loopback
    // callers (the desktop webview) pass unchanged.
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();

    return sseResponse<FrameViewVocabulary>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      setup: (sink) => {
        const off = subscribeFrameView(slug, workspaceId, {
          onThumb: (t) => {
            if (!sink.closed) sink.event('thumb', t);
          },
          onStatus: (s) => {
            if (!sink.closed) sink.event('status', s);
          },
        });
        sink.onClose(off);
      },
    });
  },
});
