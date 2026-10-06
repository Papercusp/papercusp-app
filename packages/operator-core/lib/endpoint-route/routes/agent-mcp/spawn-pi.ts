/**
 * POST /api/agent-mcp/spawn-pi — provision a pi:<session-id> principal.
 * Ported from app/api/agent-mcp/spawn-pi/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 *
 * WI-10003619: the returned MCP server config carries ONLY the pi session's own
 * scoped bearer. It used to read `~/.papercusp/superuser-token` and embed it as
 * an `Authorization:Bearer` arg, which (a) handed a '*'-capability credential to
 * a principal that had asked for a scoped capability set, and (b) on a hosted
 * workspace VM leaked the operator's superuser token to any account that could
 * reach loopback (measured on avi-test: customer uid 1001 received it). The
 * loopback peer-uid gate now refuses such callers too; this is the second layer.
 */
import { randomBytes } from 'node:crypto';
import { getCatalog } from '@papercusp/agent-mcp';
import { DEFAULT_PI_CAPABILITIES, startPiSession } from '@papercusp/agent-mcp/provisioning';
import { papercuspRoot } from '../../../papercusp-root';
import { activeWorkspaceId } from '../../../workspace-registry';
import { operatorApiBase } from '../../../operator-api-base';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import '../../../agent-tools/index';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/spawn-pi',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => ({}))) as {
      sessionId?: string;
      capabilities?: string[];
    };
    const sessionId = body.sessionId ?? randomBytes(8).toString('hex');
    const workspaceId = activeWorkspaceId();
    // Preserve the existing default grant, then bind the bearer to the exact
    // canonical names visible under those capabilities. The URL/client surface
    // is not an authorization boundary by itself.
    const capabilities = body.capabilities?.length ? body.capabilities : DEFAULT_PI_CAPABILITIES;
    const granted = new Set(capabilities);
    const allowedTools = getCatalog()
      .filter((tool) => granted.has('*') || granted.has(tool.capability))
      .map((tool) => tool.name);
    const result = await startPiSession({
      workspaceId,
      sessionId,
      capabilities,
      allowedTools,
    });

    const mcpServer = {
      command: './node_modules/.bin/tsx',
      args: [join(process.cwd(), 'packages/agent-mcp/src/server-entry.ts')],
      env: {
        AGENT_MCP_BEARER: result.bearer,
        OPERATOR_BASE_URL: operatorApiBase(),
        PAPERCUSP_HOME: papercuspRoot(),
      } as Record<string, string>,
    };

    return Response.json({
      sessionId: result.sessionId,
      bearer: result.bearer,
      mcpServer,
    });
  },
});
