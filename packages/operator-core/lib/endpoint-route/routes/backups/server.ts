/**
 * GET    /api/backups/server — start (idempotent) + return iframe URL.
 * DELETE /api/backups/server — stop the kopia server for this workspace.
 *
 * Ported from app/api/backups/server/route.ts. `auth: 'public'`.
 */
import { startKopiaServer, stopKopiaServer, kopiaServerStatus } from '../../../backup';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/backups/server',
  auth: 'public',
  async handler() {
    try {
      const ws = activeWorkspaceId();
      const existing = kopiaServerStatus(ws);
      const info = existing ?? (await startKopiaServer(ws));
      return Response.json({ server: info });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/backups/server',
  auth: 'loopback',
  handler() {
    const ws = activeWorkspaceId();
    const stopped = stopKopiaServer(ws);
    return Response.json({ stopped });
  },
});

export default [get, del];
