/** P-003: typed SU-session attachment on the existing agent-chats transport. */
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { committedRouteResponse } from '../../route-stack';
import { createSuSessionEventResponse } from '../../../su-session-host';
import {
  SU_SESSION_SERVED_BY_HEADER,
  createForwardedSuSessionEventResponse,
  localHost,
  resolveSuSessionRoute,
  runRoutedSuSessionOp,
  type SuSessionAddress,
  type SuSessionHostOp,
} from '../../../su-session-owner-routing';

// WI-10003879: every handler below routes through su-session-owner-routing, so
// on a clustered operator the worker that holds the session's engine answers,
// not whichever worker SO_REUSEPORT happened to pick.

type RouteParams = Record<string, string>;

function addressOf(params: RouteParams): SuSessionAddress {
  return { workspaceId: activeWorkspaceId(), harnessSlug: params.slug, agentChatId: params.chatId };
}

const NOT_ATTACHED = {
  error: 'no SU session is attached to this agent chat',
  code: 'su_session_not_attached',
};

async function routed(
  params: RouteParams,
  request: Exclude<SuSessionHostOp, { op: 'events' }>,
): Promise<Response> {
  const outcome = await runRoutedSuSessionOp(addressOf(params), request);
  if (outcome instanceof Response) return outcome;
  const response = Response.json(outcome.result.body, {
    status: outcome.result.status,
    headers: { [SU_SESSION_SERVED_BY_HEADER]: outcome.servedBy },
  });
  // acceptCommand reserves owner turns before returning an acceptance.
  // A route watchdog cannot undo that committed turn or its receipt.
  return outcome.result.committed ? committedRouteResponse(response) : response;
}

const snapshotRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats/:chatId/su-session',
  auth: 'public',
  async handler(_request, context) {
    return routed(context.params, { op: 'snapshot' });
  },
});

const eventsRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats/:chatId/su-session/events',
  auth: 'public',
  async handler(request, context) {
    const address = addressOf(context.params);
    const route = await resolveSuSessionRoute(address);
    if (route.kind === 'remote') {
      const forwarded = await createForwardedSuSessionEventResponse(request, address, route.owner);
      if (forwarded) return forwarded;
      // The owner is gone or no longer holds it: serve the durable row here.
      const fallback = await localHost(address);
      if (fallback) return createSuSessionEventResponse(request, fallback);
      return Response.json(NOT_ATTACHED, { status: 404 });
    }
    if (route.kind === 'absent') return Response.json(NOT_ATTACHED, { status: 404 });
    return createSuSessionEventResponse(request, route.host);
  },
});

const commandRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats/:chatId/su-session/commands',
  auth: 'loopback',
  async handler(request, context) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid JSON command body', code: 'invalid_command' }, { status: 400 });
    }
    return routed(context.params, { op: 'command', body });
  },
});

/**
 * pui-chat-first-ux-2026-09-28 P-009: keep this session's engine running after
 * its client leaves. Without it the engine ends once no client has been
 * attached for the lease TTL. The next attach clears the detach again.
 */
const detachRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats/:chatId/su-session/detach',
  auth: 'loopback',
  async handler(_request, context) {
    return routed(context.params, { op: 'detach' });
  },
});

export const suSessionRoutes = [snapshotRoute, eventsRoute, commandRoute, detachRoute];

export default suSessionRoutes;
