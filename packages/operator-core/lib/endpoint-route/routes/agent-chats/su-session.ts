/** P-003: typed SU-session attachment on the existing agent-chats transport. */
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { committedRouteResponse } from '../../route-stack';
import {
  SuSessionHostError,
  createSuSessionEventResponse,
  getRegisteredSuSessionHost,
  rehydrateRegisteredSuSessionHost,
} from '../../../su-session-host';
import { readDurableSuSession } from '../../../su-session-persistence';
import { detachSuClientLease } from '../../../su-session-client-lease';

async function hostFor(slug: string, chatId: string) {
  const input = {
    workspaceId: activeWorkspaceId(),
    harnessSlug: slug,
    agentChatId: chatId,
  };
  return getRegisteredSuSessionHost(input) ?? (await rehydrateRegisteredSuSessionHost(input));
}

const snapshotRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats/:chatId/su-session',
  auth: 'public',
  async handler(_request, context) {
    const host = await hostFor(context.params.slug, context.params.chatId);
    if (!host) {
      return Response.json(
        {
          error: 'no SU session is attached to this agent chat',
          code: 'su_session_not_attached',
        },
        { status: 404 },
      );
    }
    // pui-chat-first-ux P-010: PUI scopes /resume and its startup reattach to
    // the directory it was started in, so the snapshot names the directory this
    // session was launched in. `null` = not recorded (e.g. a psu launch without
    // a caller directory), which PUI treats as "unknown", never "matches".
    const record = await readDurableSuSession({
      agentChatId: context.params.chatId,
      workspaceId: activeWorkspaceId(),
    });
    return Response.json({ ok: true, ...host.snapshot(), launchCwd: record?.cwd ?? null });
  },
});

const eventsRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats/:chatId/su-session/events',
  auth: 'public',
  async handler(request, context) {
    const host = await hostFor(context.params.slug, context.params.chatId);
    if (!host) {
      return Response.json(
        {
          error: 'no SU session is attached to this agent chat',
          code: 'su_session_not_attached',
        },
        { status: 404 },
      );
    }
    return createSuSessionEventResponse(request, host);
  },
});

const commandRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats/:chatId/su-session/commands',
  auth: 'loopback',
  async handler(request, context) {
    const host = await hostFor(context.params.slug, context.params.chatId);
    if (!host) {
      return Response.json(
        {
          error: 'no SU session is attached to this agent chat',
          code: 'su_session_not_attached',
        },
        { status: 404 },
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid JSON command body', code: 'invalid_command' }, { status: 400 });
    }
    try {
      const dispatch = await host.acceptCommand(body);
      if (!dispatch.accepted) {
        return Response.json(
          {
            ok: false,
            replayed: dispatch.replayed,
            terminal: await dispatch.terminal,
          },
          { status: 409 },
        );
      }
      const response = Response.json(
        {
          ok: true,
          replayed: dispatch.replayed,
          accepted: dispatch.accepted,
        },
        { status: 202 },
      );
      // acceptCommand reserves owner turns before returning an acceptance.
      // A route watchdog cannot undo that committed turn or its receipt.
      return dispatch.accepted.commandType === 'owner_turn'
        ? committedRouteResponse(response)
        : response;
    } catch (error) {
      if (error instanceof SuSessionHostError) {
        return Response.json({ error: error.message, code: error.code }, { status: error.status });
      }
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
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
    const host = await hostFor(context.params.slug, context.params.chatId);
    if (!host) {
      return Response.json(
        { error: 'no SU session is attached to this agent chat', code: 'su_session_not_attached' },
        { status: 404 },
      );
    }
    if (host.snapshot().terminal) {
      return Response.json(
        { error: 'this session has already ended', code: 'session_terminal' },
        { status: 409 },
      );
    }
    const detached = await detachSuClientLease(host.descriptor().identity.advSessionId);
    return detached
      ? Response.json({ ok: true, detached: true })
      : Response.json({ error: 'this session has already ended', code: 'session_terminal' }, { status: 409 });
  },
});

export const suSessionRoutes = [snapshotRoute, eventsRoute, commandRoute, detachRoute];

export default suSessionRoutes;
