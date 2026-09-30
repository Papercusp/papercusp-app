/**
 * POST /api/agent-mcp/run-command/result — leader tab posts command result back.
 * Ported from app/api/agent-mcp/run-command/result/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { resolveRequest } from '../../../commands/session-registry';
import type { CommandResult } from '../../../commands/types';
import { defineTool } from '@papercusp/agent-mcp';

interface Body {
  requestId?: string;
  result?: CommandResult;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/run-command/result',
  auth: 'loopback',
  async handler(req) {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    if (!body.requestId || !body.result) {
      return new Response('missing requestId or result', { status: 400 });
    }
    const ok = resolveRequest(body.requestId, body.result);
    return Response.json({ ok });
  },
});
