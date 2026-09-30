/**
 * GET  /api/agent-mcp/operator-hindsight          → { pending }
 * GET  /api/agent-mcp/operator-hindsight?drain=1  → { items: [{ headline, kind }] }
 * POST /api/agent-mcp/operator-hindsight           → push one hindsight notify
 *
 * The "while you were away" channel on the coord substrate (collapse-delegate D-003).
 * Replaces /api/agent-mcp/delegate-inbox: notifications are coord notifies addressed
 * to the operator owner, drained non-destructively (voice-scoped acks). `auth: 'public'`.
 */
import {
  drainOperatorHindsight,
  peekOperatorHindsight,
  notifyOperatorHindsight,
} from '../../../operator-hindsight';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-hindsight',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const drain = url.searchParams.get('drain') === '1';
    if (drain) {
      const items = await drainOperatorHindsight();
      return Response.json({ items });
    }
    const peek = await peekOperatorHindsight();
    return Response.json(peek);
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-hindsight',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => null)) as
      | { headline?: string; kind?: string }
      | null;
    if (!body?.headline) {
      return Response.json({ error: 'headline required' }, { status: 400 });
    }
    await notifyOperatorHindsight(body.headline, body.kind);
    return Response.json({ ok: true });
  },
});

export default [get, post];
