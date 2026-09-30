/**
 * GET/POST/DELETE /api/:transport
 *
 * MCP transport — built-in tools + projected tools + resources + prompts
 * over HTTP. Wraps the mcp-handler-built handler (Streamable-HTTP only,
 * SSE disabled).
 *
 * Ported from app/api/[transport]/route.ts. `auth: 'public'`.
 */
import { mcpHandler } from './_mcp-handler';
import { defineTool } from '@papercusp/agent-mcp';

const PATH = '/:transport';
const methods = ['GET', 'POST', 'DELETE'] as const;

export default methods.map((method) =>
  defineTool({
    method,
    path: PATH,
    auth: 'public',
    handler: mcpHandler,
  }),
);
