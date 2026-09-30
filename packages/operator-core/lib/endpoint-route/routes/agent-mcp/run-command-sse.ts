/**
 * GET /api/agent-mcp/run-command/sse — leader-tab SSE channel for browser commands.
 * Ported from app/api/agent-mcp/run-command/sse/route.ts. `auth: 'public'`.
 */
import { sseResponse } from '@papercusp/sse';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import {
  registerSession,
  unregisterSession,
  heartbeatSession,
} from '../../../commands/session-registry';
import { defineTool } from '@papercusp/agent-mcp';

type Events = {
  hello: { workspace: string; sessionId: string };
  command: { requestId: string; command: unknown };
};

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/run-command/sse',
  auth: 'public',
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  handler(req) {
    const url = new URL(req.url);
    const workspace = url.searchParams.get('workspace');
    const sessionId = url.searchParams.get('sessionId');
    if (!workspace || !sessionId) {
      return new Response('missing workspace or sessionId', { status: 400 });
    }

    return sseResponse<Events>({
      signal: req.signal,
      heartbeatMs: 5000,
      setup: (sink) => {
        registerSession({
          workspace,
          sessionId,
          push: (request) => {
            sink.event('command', { requestId: request.requestId, command: request.command });
          },
        });

        sink.event('hello', { workspace, sessionId });

        const sessionCheck = managedSetInterval('run-command-sse-session', 5000, () => {
          if (!heartbeatSession(workspace, sessionId)) {
            sink.close();
          }
        }, { category: 'lifecycle', instanced: true });

        sink.onClose(() => {
          sessionCheck.stop();
          unregisterSession(workspace, sessionId);
        });
      },
    });
  },
});
