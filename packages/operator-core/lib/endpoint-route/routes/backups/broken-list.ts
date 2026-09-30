/**
 * GET /api/backups/broken-list — list .broken-* dirs for rollback offers.
 *
 * Ported from app/api/backups/broken-list/route.ts. `auth: 'public'`.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { activeWorkspaceId, workspacesRoot } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/backups/broken-list',
  auth: 'public',
  async handler() {
    try {
      const root = join(workspacesRoot(), activeWorkspaceId());
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const broken: { path: string; createdAt: string; sizeMb: number | null }[] = [];
      for (const e of entries) {
        if (!e.isDirectory() || !e.name.startsWith('.broken-')) continue;
        const full = join(root, e.name);
        const s = await stat(full).catch(() => null);
        broken.push({
          path: full,
          createdAt: s?.mtime.toISOString() ?? new Date(0).toISOString(),
          sizeMb: null,
        });
      }
      broken.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return Response.json({ broken });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});
