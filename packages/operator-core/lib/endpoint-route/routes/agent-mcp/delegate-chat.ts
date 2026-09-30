/**
 * GET /api/agent-mcp/delegate-chat — retired delegate endpoint tombstone.
 *
 * `operator:delegate` / `delegate_to_claude` were retired 2026-06-21. Keep
 * this route as a clear 410 for stale clients instead of letting them hit an
 * unmapped route or a hidden tool.
 */
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/delegate-chat',
  auth: 'public',
  sampleRate: 0,
  handler() {
    return Response.json(
      {
        status: 'error',
        error: 'delegate-chat is retired; use operator:converse for the human-facing brain or work_items/coordination tools for durable agent work.',
      },
      { status: 410 },
    );
  },
});
