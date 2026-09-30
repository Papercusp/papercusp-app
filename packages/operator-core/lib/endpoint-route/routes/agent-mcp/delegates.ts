/**
 * GET    /api/agent-mcp/delegates — list / get / search the operator's delegated
 *                                   tasks (work_items, kind=task) as "sessions".
 * DELETE /api/agent-mcp/delegates?id= — archive (state → closed).
 *
 * collapse-delegate-into-workitems-2026-06-04: a delegate IS a work_item, so this
 * endpoint now projects task work_items into the session shape the panel + voice
 * picker consume — no bespoke `delegates` table. `auth: 'public'`.
 */
import {
  archiveDelegatedSession,
  getDelegatedSession,
  listDelegatedSessions,
  searchDelegatedSessions,
} from '../../../delegated-tasks';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/delegates',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (id) {
      const session = await getDelegatedSession(id);
      return Response.json({ session });
    }
    const status = (url.searchParams.get('status') as 'open' | 'archived' | 'all' | null) ?? 'open';
    const limit = url.searchParams.get('limit')
      ? Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit')!, 10) || 20))
      : 20;
    const q = url.searchParams.get('q');
    const sessions = q
      ? await searchDelegatedSessions(q, limit)
      : await listDelegatedSessions({ status, limit });
    return Response.json({ sessions });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/agent-mcp/delegates',
  auth: 'loopback',
  async handler(req) {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return Response.json({ error: 'missing id' }, { status: 400 });
    await archiveDelegatedSession(id);
    return Response.json({ ok: true });
  },
});

export default [get, del];
