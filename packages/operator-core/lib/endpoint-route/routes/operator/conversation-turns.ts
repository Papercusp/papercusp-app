/**
 * GET  /api/operator/conversations/:id/turns?beforeSeq=N&limit=M
 * POST /api/operator/conversations/:id/turns  — append a turn
 *
 * `:id` accepts the literal `active` (WI-4838): it resolves the ACTIVE
 * conversation server-side (per the request's workspace) instead of trusting
 * the client to know the id. This is the no-silent-skip seam — a window whose
 * `operatorConversations.current` sync read hasn't resolved (degraded sync,
 * boot race) can still persist a turn; the response carries the resolved
 * `conversationId` so the client adopts it. Conversation ids are uuids, so
 * the literal can never shadow a real id.
 *
 * Ported from app/api/operator/conversations/[id]/turns/route.ts. `auth: 'public'`.
 */
import {
  appendTurn,
  getConversationById,
  getOrCreateActiveConversation,
  listTurnsRecent,
  type TurnRole,
  type TurnSource,
} from '../../../operator-conversations';
import { parseReportBody } from '../../../operator-converse-tags';
import { notifySyncInvalidate } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

interface Body {
  role: TurnRole;
  text: string;
  source?: TurnSource;
  elConvId?: string | null;
  tools?: Array<{ name: string; input?: unknown; answered?: unknown }>;
  /** Structured `<report>` payload (structured-report-protocol-2026-06-05). */
  report?: unknown;
}

async function resolveConversationId(raw: string): Promise<string | null> {
  if (raw === 'active') return (await getOrCreateActiveConversation()).id;
  return (await getConversationById(raw))?.id ?? null;
}

const get = defineTool({
  method: 'GET',
  path: '/operator/conversations/:id/turns',
  auth: 'public',
  async handler(req, ctx) {
    const raw = ctx.params.id as string;
    const id = await resolveConversationId(raw);
    if (!id) {
      return Response.json({ error: 'conversation not found' }, { status: 404 });
    }
    const url = new URL(req.url);
    const beforeRaw = url.searchParams.get('beforeSeq');
    const limitRaw = url.searchParams.get('limit');
    const beforeSeq = beforeRaw === null || beforeRaw === '' ? null : Number(beforeRaw);
    if (beforeSeq !== null && (!Number.isFinite(beforeSeq) || beforeSeq < 0)) {
      return Response.json({ error: 'beforeSeq must be a non-negative integer' }, { status: 400 });
    }
    const limit = Math.max(1, Math.min(Number(limitRaw) || 50, 500));
    const page = await listTurnsRecent({ conversationId: id, beforeSeq, limit });
    return Response.json(page);
  },
});

const post = defineTool({
  method: 'POST',
  path: '/operator/conversations/:id/turns',
  auth: 'loopback',
  async handler(req, ctx) {
    const raw = ctx.params.id as string;
    const id = await resolveConversationId(raw);
    if (!id) {
      return Response.json({ error: 'conversation not found' }, { status: 404 });
    }
    const body = (await req.json()) as Body;
    if (!body || typeof body.text !== 'string' || !body.role) {
      return Response.json({ error: 'role and text required' }, { status: 400 });
    }
    // Re-validate the report server-side (defensive — never store junk):
    // round-trip the client object through parseReportBody.
    const report =
      body.report != null ? parseReportBody(JSON.stringify(body.report)) : null;
    const turn = await appendTurn({
      conversationId: id,
      role: body.role,
      text: body.text,
      source: body.source,
      elConvId: body.elConvId ?? null,
      tools: Array.isArray(body.tools) && body.tools.length > 0 ? (body.tools as any) : null,
      report,
    });
    void notifySyncInvalidate('operatorTurns.page', { conversationId: id })
      .catch(() => { /* best-effort */ });
    // conversationId lets an `active` caller adopt the resolved id.
    return Response.json({ turn, conversationId: id });
  },
});

export default [get, post];
