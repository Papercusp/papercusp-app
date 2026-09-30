/**
 * POST /api/backups/verify — kopia snapshot verify.
 *
 * Ported from app/api/backups/verify/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { workspaceBackupFor } from '../../../backup';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/backups/verify',
  auth: 'loopback',
  async handler() {
    try {
      const wb = workspaceBackupFor(activeWorkspaceId());
      const trace = await wb.kopiaTraced(['snapshot', 'verify']);
      return Response.json({
        result: { ok: trace.exitCode === 0, errors: trace.exitCode === 0 ? [] : [trace.stderr] },
        trace,
      });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});
