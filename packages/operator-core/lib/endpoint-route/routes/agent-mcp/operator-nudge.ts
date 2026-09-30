/**
 * POST /api/agent-mcp/operator-nudge — dedup-arbitrated spoken nudges.
 * Ported from app/api/agent-mcp/operator-nudge/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { maybeFireNudge, type NudgeKind } from '../../../voice-nudges';
import { defineTool } from '@papercusp/agent-mcp';

const ALLOWED: ReadonlySet<NudgeKind> = new Set(['budget', 'breaker', 'pause']);

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-nudge',
  auth: 'loopback',
  async handler(req) {
    let body: { kind?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    const kind = body.kind as NudgeKind;
    if (!ALLOWED.has(kind)) {
      return new Response('kind must be budget|breaker|pause', { status: 400 });
    }
    const fired = await maybeFireNudge(kind);
    return Response.json({ fired, kind });
  },
});
