/**
 * POST /api/agent-mcp/run-command — Action Registry cross-process bridge.
 * Ported from app/api/agent-mcp/run-command/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { randomUUID } from 'node:crypto';
import { activeWorkspaceId } from '../../../workspace-registry';
import { get, runCommand, runQuery } from '../../../commands/registry';
import { deliver as deliverToTab } from '../../../commands/session-registry';
import type { AgentId, CommandContext, CommandResult } from '../../../commands/types';
import { audit } from '../../../commands/audit';
import '../../../commands/audit-server';
import '../../../commands/defs';
import { defineTool } from '@papercusp/agent-mcp';

interface Body {
  id?: string;
  args?: unknown;
  workspace?: string;
  agent?: AgentId;
  sessionId?: string;
}

function errorResponse(
  code: string,
  message: string,
  retryable: boolean,
  status: number,
): Response {
  return Response.json(
    { ok: false, error: { code, message, retryable } },
    { status },
  );
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/run-command',
  auth: 'loopback',
  async handler(req) {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return errorResponse('invalid-args', 'request body must be JSON', false, 400);
    }
    if (!body.id || typeof body.id !== 'string') {
      return errorResponse('invalid-args', 'missing field: id', false, 400);
    }

    const def = get(body.id);
    if (!def) return errorResponse('unknown', `no such command: ${body.id}`, false, 404);

    const ctx: CommandContext = {
      agent: body.agent ?? 'operator',
      workspace: body.workspace ?? activeWorkspaceId(),
      sessionId: body.sessionId,
      requestId: randomUUID(),
    };

    if (def.kind === 'command' && def.browser === 'required') {
      const startedAt = Date.now();
      const result = await deliverToTab(ctx.workspace, { id: body.id, args: body.args });
      audit({
        id: body.id,
        agent: ctx.agent,
        workspace: ctx.workspace,
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
        args: body.args ?? {},
        status: result.ok ? 'ok' : 'err',
        errorCode: result.ok ? undefined : result.error.code,
        durationMs: Date.now() - startedAt,
      });
      return Response.json(result);
    }

    const result: CommandResult =
      def.kind === 'command'
        ? await runCommand(body.id, body.args, ctx)
        : await runQuery(body.id, body.args, ctx);
    return Response.json(result);
  },
});
