/**
 * POST /api/backups/promote — promote a restored clone to live.
 *
 * Ported from app/api/backups/promote/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { z } from 'zod';
import { triggerSnapshotEvent } from '../../../backup';
import { durablePromoteRestore } from '../../../backup/durable-ops';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const Schema = z.object({
  restoredPath: z.string().min(1),
  liveTarget: z.string().min(1).optional(),
});

export default defineTool({
  method: 'POST',
  path: '/backups/promote',
  auth: 'loopback',
  async handler(req) {
    try {
      const body = await req.json();
      const args = Schema.parse(body);
      const ws = activeWorkspaceId();
      await triggerSnapshotEvent(ws, 'pre_destructive', { op: 'promote_restore', restoredPath: args.restoredPath })
        .catch(() => { /* non-fatal */ });
      const result = await durablePromoteRestore(ws, args);
      return Response.json({ result });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});
