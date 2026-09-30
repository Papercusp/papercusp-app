/**
 * POST /api/backups/maintenance — kopia maintenance run.
 *
 * Ported from app/api/backups/maintenance/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { z } from 'zod';
import { workspaceBackupFor } from '../../../backup';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const Schema = z.object({ level: z.enum(['quick', 'full']).default('quick') });

export default defineTool({
  method: 'POST',
  path: '/backups/maintenance',
  auth: 'loopback',
  async handler(req) {
    try {
      const body = await req.json().catch(() => ({}));
      const { level } = Schema.parse(body);
      const wb = workspaceBackupFor(activeWorkspaceId());
      const args = level === 'full' ? ['maintenance', 'run', '--full'] : ['maintenance', 'run'];
      const trace = await wb.kopiaTraced(args);
      return Response.json({ ok: trace.exitCode === 0, trace });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});
