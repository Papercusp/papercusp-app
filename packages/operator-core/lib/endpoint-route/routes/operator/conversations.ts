/**
 * GET  /api/operator/conversations?limit=N
 * POST /api/operator/conversations  — force-create active conversation
 *
 * Ported from app/api/operator/conversations/route.ts. `auth: 'public'`.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';
import {
  getOrCreateActiveConversation,
  getOrCreateWorkItemConversation,
  getWorkItemConversation,
  listTurns,
  listTurnsRecent,
} from '../../../operator-conversations';
import { resolveCanonicalWorkItemSubject } from '../../../operator-conversation-subject';
import { notifySyncInvalidate } from '../../../sync-sse';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const oc = generated.operatorConversationsInHarnessShared;

function requestedHarness(req: Request, body?: { harness?: unknown } | null): string {
  const fromBody = typeof body?.harness === 'string' ? body.harness.trim() : '';
  if (fromBody) return fromBody;
  return new URL(req.url).searchParams.get('harness')?.trim() ?? '';
}

const get = defineTool({
  method: 'GET',
  path: '/operator/conversations',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const limitParam = url.searchParams.get('limit');
    const conv = await getOrCreateActiveConversation();

    if (limitParam === 'all') {
      const turns = await listTurns(conv.id);
      return Response.json({ conversation: conv, turns, hasMoreEarlier: false });
    }
    const limit = Math.max(1, Math.min(Number(limitParam) || 50, 500));
    const page = await listTurnsRecent({ conversationId: conv.id, limit });
    return Response.json({
      conversation: conv,
      turns: page.turns,
      hasMoreEarlier: page.hasMoreEarlier,
    });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/operator/conversations',
  auth: 'loopback',
  async handler() {
    const ws = activeWorkspaceId();
    const { db } = getOrgPg();

    await db
      .update(oc)
      .set({ status: 'done', endedAt: Date.now() })
      .where(
        and(
          eq(oc.workspaceId, ws),
          eq(oc.status, 'active'),
          dsql`subject_kind = 'global'`,
          dsql`subject_ref IS NULL`,
        ),
      );

    const created = await db
      .insert(oc)
      .values({ workspaceId: ws, harnessSlug: null, startedAt: Date.now() })
      .returning({ id: oc.id });
    const id = created[0].id;
    return Response.json({ conversation: { id }, turns: [] });
  },
});

const getWorkItem = defineTool({
  method: 'GET',
  path: '/operator/conversations/work-items/:workItemId',
  auth: 'public',
  async handler(req, ctx) {
    const harness = requestedHarness(req);
    const workItemId = (ctx.params.workItemId as string)?.trim();
    if (!harness || !workItemId) {
      return Response.json(
        { error: 'harness query parameter and workItemId are required' },
        { status: 400 },
      );
    }
    const conversation = await getWorkItemConversation({ harnessSlug: harness, workItemId });
    if (!conversation) {
      return Response.json({ error: 'work-item conversation not found' }, { status: 404 });
    }
    return Response.json({ conversation });
  },
});

const postWorkItem = defineTool({
  method: 'POST',
  path: '/operator/conversations/work-items/:workItemId',
  auth: 'loopback',
  async handler(req, ctx) {
    const body = (await req.json().catch(() => null)) as { harness?: unknown } | null;
    const harness = requestedHarness(req, body);
    const workItemId = (ctx.params.workItemId as string)?.trim();
    if (!harness || !workItemId) {
      return Response.json(
        { error: 'harness and workItemId are required' },
        { status: 400 },
      );
    }

    // Creation is the mutation boundary, so validate the canonical work item
    // here. The durable binding intentionally has no FK and survives later item
    // lifecycle/deletion; reads of an already-bound transcript remain valid.
    const subject = await resolveCanonicalWorkItemSubject(harness, workItemId);
    if (!subject) {
      return Response.json(
        { error: 'work item not found in the requested workspace/harness' },
        { status: 404 },
      );
    }

    const conversation = await getOrCreateWorkItemConversation({
      harnessSlug: subject.harness,
      workItemId: subject.id,
    });
    void notifySyncInvalidate('operatorConversations.byWorkItem', {
      workspaceId: activeWorkspaceId(),
      harness: subject.harness,
      workItemId: subject.id,
    }).catch(() => { /* best-effort */ });
    return Response.json({ conversation });
  },
});

export default [get, post, getWorkItem, postWorkItem];
