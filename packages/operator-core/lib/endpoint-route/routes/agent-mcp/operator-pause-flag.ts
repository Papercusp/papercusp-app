/**
 * GET    /api/agent-mcp/operator-pause-flag — read paused state.
 * POST   — set paused=true.
 * DELETE — set paused=false.
 * Ported from app/api/agent-mcp/operator-pause-flag/route.ts. `auth: 'public'`.
 */
import { getSessionUser } from '../../../auth';
import { setPaused, setResumed, isPaused } from '../../../device-operator-actions';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-pause-flag',
  auth: 'public',
  async handler() {
    return Response.json({ paused: await isPaused() });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-pause-flag',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) {
      return Response.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    }
    await setPaused(user.username);
    return Response.json({ ok: true, paused: true });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/agent-mcp/operator-pause-flag',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) {
      return Response.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    }
    await setResumed();
    return Response.json({ ok: true, paused: false });
  },
});

export default [get, post, del];
