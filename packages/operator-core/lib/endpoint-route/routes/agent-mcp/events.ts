/**
 * GET /api/agent-mcp/events — SSE stream of pending_events for active workspace.
 * Ported from app/api/agent-mcp/events/route.ts. `auth: 'public'`.
 */
import { sseResponse } from '@papercusp/sse';
import { onPendingEventInserted } from '../../../pending-events-listener';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

type Events = {
  hello: { workspaceId: string };
  pending_event: Record<string, unknown>;
}

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/events',
  auth: 'public',
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  handler(req) {
    const ws = activeWorkspaceId();
    return sseResponse<Events>({
      signal: req.signal,
      heartbeatMs: 30_000,
      setup: (sink) => {
        sink.event('hello', { workspaceId: ws });
        const unsub = onPendingEventInserted((evt) => {
          if (evt.workspace_id !== ws) return;
          sink.event('pending_event', evt as unknown as Record<string, unknown>);
        });
        sink.onClose(unsub);
      },
    });
  },
});
