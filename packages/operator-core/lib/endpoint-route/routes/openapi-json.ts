/**
 * GET /api/openapi.json — runtime-assembled OpenAPI 3.1 document.
 *
 * Walks the live projection registry (`listAllProjectedTools()`) +
 * the defineTool fragments and emits one path per operation.
 *
 * Ported from app/api/openapi.json/route.ts. `auth: 'public'`.
 */
import { assembleOpenApiDocument, listAllProjectedTools } from '@papercusp/agent-mcp';
import { allRouteFragments } from '../openapi';
import '../../agent-tools/index';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/openapi.json',
  auth: 'public',
  handler(req) {
    const tools = listAllProjectedTools();
    const origin = (() => {
      try {
        return new URL(req.url).origin;
      } catch {
        return null;
      }
    })();
    const doc = assembleOpenApiDocument(tools, {
      title: 'Papercusp API',
      description:
        'The full Papercusp API surface. `defineTool` operations are agent ' +
        'tools (POST, with a typed event channel under text/event-stream). ' +
        '`defineTool` operations (x-papercusp-projection: route) are HTTP ' +
        'plumbing endpoints — UI data, webhooks, transports.',
      ...(origin ? { servers: [{ url: origin, description: 'this operator' }] } : {}),
      extraFragments: allRouteFragments(),
    });
    return Response.json(doc);
  },
});
