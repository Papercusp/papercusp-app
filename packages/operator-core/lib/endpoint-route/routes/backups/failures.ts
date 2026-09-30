/**
 * GET /api/backups/failures?limit=N — recent backup failures.
 *
 * Ported from app/api/backups/failures/route.ts. `auth: 'public'`.
 */
import { workspaceBackupFor } from '../../../backup';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/backups/failures',
  auth: 'public',
  async handler(req) {
    try {
      const url = new URL(req.url);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
      const wb = workspaceBackupFor(activeWorkspaceId());
      const failures = await wb.recentFailures(limit);
      return Response.json({ failures });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});
