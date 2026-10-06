import { defineTool } from '@papercusp/agent-mcp';
import { appendExternalChatTurn, deleteExternalChatTurns } from '../../../agent-chats-data';
import { acquireAgentChatLock, releaseAgentChatLock } from '../../../agent-chat-lock';
import { activeWorkspaceId } from '../../../workspace-registry';

/**
 * Server-to-server transcript bridge for LiveKit phone turns (P-010).
 *
 * This route deliberately lives beside the normal agent-chat transport but is
 * not a `messages` alias: it appends a finalized turn and never starts an
 * assistant run. `loopback` is the only auth tier; the browser-facing portal
 * proxy does not expose this path.
 */
export const externalTurnRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats/:chatId/external-turns',
  auth: 'loopback',
  async handler(req, ctx) {
    let body: {
      role?: unknown;
      content?: unknown;
      sourceId?: unknown;
      source?: unknown;
      ts?: unknown;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    if (body.source !== 'phone-livekit') {
      return Response.json({ error: 'source must be phone-livekit' }, { status: 400 });
    }
    if (body.role !== 'user' && body.role !== 'assistant') {
      return Response.json({ error: 'role must be user or assistant' }, { status: 400 });
    }
    if (typeof body.content !== 'string' || !body.content.trim()) {
      return Response.json({ error: 'content is required' }, { status: 400 });
    }
    if (body.content.trim().length > 4_000) {
      return Response.json({ error: 'content exceeds 4000 characters' }, { status: 400 });
    }
    if (typeof body.sourceId !== 'string' || !body.sourceId.trim() || body.sourceId.length > 256) {
      return Response.json({ error: 'sourceId is required' }, { status: 400 });
    }
    if (body.ts !== undefined && (typeof body.ts !== 'string' || !Number.isFinite(Date.parse(body.ts)))) {
      return Response.json({ error: 'ts must be an ISO timestamp' }, { status: 400 });
    }

    // Share the exact lock used by `/messages`. Its writer replaces the whole
    // transcript from a preflight snapshot, so an external append during that
    // stream could otherwise be overwritten when the assistant finishes.
    const lock = await acquireAgentChatLock(ctx.params.chatId, activeWorkspaceId());
    if (!lock) {
      return Response.json({ error: 'chat already has an in-flight transcript write' }, { status: 409 });
    }
    try {
      const result = await appendExternalChatTurn({
        slug: ctx.params.slug,
        chatId: ctx.params.chatId,
        role: body.role,
        content: body.content,
        sourceId: body.sourceId,
        source: 'phone-livekit',
        ...(typeof body.ts === 'string' ? { ts: body.ts } : {}),
      });
      if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
      return Response.json({ ok: true, appended: result.data.appended });
    } finally {
      await releaseAgentChatLock(lock);
    }
  },
});

/**
 * Retention/deletion counterpart of the bridge (WI-10006406, D-022).
 *
 * The Phone sidecar calls this before it deletes a call's own content, so the
 * mirrored copy cannot outlive the 30-day retention window or an owner's
 * delete. Loopback-only like the append route, and it takes the same chat
 * lock so it cannot race a `/messages` whole-transcript rewrite.
 */
export const deleteExternalTurnsRoute = defineTool({
  method: 'DELETE',
  path: '/harness/:slug/agent-chats/:chatId/external-turns',
  auth: 'loopback',
  async handler(req, ctx) {
    let body: { source?: unknown; roomName?: unknown };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    if (body.source !== 'phone-livekit') {
      return Response.json({ error: 'source must be phone-livekit' }, { status: 400 });
    }
    if (typeof body.roomName !== 'string') {
      return Response.json({ error: 'roomName is required' }, { status: 400 });
    }
    const lock = await acquireAgentChatLock(ctx.params.chatId, activeWorkspaceId());
    if (!lock) {
      return Response.json({ error: 'chat already has an in-flight transcript write' }, { status: 409 });
    }
    try {
      const result = await deleteExternalChatTurns({
        slug: ctx.params.slug,
        chatId: ctx.params.chatId,
        source: 'phone-livekit',
        roomName: body.roomName,
      });
      if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
      return Response.json({ ok: true, removed: result.data.removed });
    } finally {
      await releaseAgentChatLock(lock);
    }
  },
});

export default [externalTurnRoute, deleteExternalTurnsRoute];
