/**
 * POST /api/backups/rollback — undo a previous promote.
 *
 * Ported from app/api/backups/rollback/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { z } from 'zod';
import { durableRollbackPromote } from '../../../backup/durable-ops';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const Schema = z.object({ brokenPath: z.string().min(1) });

export default defineTool({
  method: 'POST',
  path: '/backups/rollback',
  auth: 'loopback',
  async handler(req) {
    try {
      const body = await req.json();
      const args = Schema.parse(body);
      const result = await durableRollbackPromote(activeWorkspaceId(), args);
      return Response.json({ result });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});
