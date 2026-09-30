/**
 * PATCH / DELETE /api/workspaces/:id — rename / remove a workspace.
 * Ported from app/api/workspaces/[id]/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { existsSync, promises as fs } from 'node:fs';
import { readRegistry, workspacesRoot, writeRegistry } from '../../../workspace-registry';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';

function validId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id);
}

export default [
  defineTool({
    method: 'PATCH',
    path: '/workspaces/:id',
    auth: 'loopback',
    async handler(req, ctx) {
      const { id } = ctx.params;
      if (!validId(id)) return Response.json({ ok: false, error: 'invalid id' }, { status: 400 });
      let body: { name?: string };
      try {
        body = await req.json();
      } catch {
        return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
      }
      const name = String(body.name ?? '').trim();
      if (!name) return Response.json({ ok: false, error: 'name required' }, { status: 400 });
      const reg = readRegistry();
      const ws = reg.workspaces.find((w) => w.id === id);
      if (!ws) return Response.json({ ok: false, error: 'not found' }, { status: 404 });
      ws.name = name;
      writeRegistry(reg);
      return Response.json({ ok: true, workspace: ws });
    },
  }),
  defineTool({
    method: 'DELETE',
    path: '/workspaces/:id',
    auth: 'loopback',
    async handler(_req, ctx) {
      const { id } = ctx.params;
      if (!validId(id)) return Response.json({ ok: false, error: 'invalid id' }, { status: 400 });
      const reg = readRegistry();
      if (!reg.workspaces.some((w) => w.id === id)) {
        return Response.json({ ok: false, error: 'not found' }, { status: 404 });
      }
      if (reg.workspaces.length <= 1) {
        return Response.json(
          { ok: false, error: 'cannot delete the last workspace' },
          { status: 400 },
        );
      }
      if (reg.current === id) {
        return Response.json(
          { ok: false, error: 'cannot delete the active workspace; switch first' },
          { status: 400 },
        );
      }
      reg.workspaces = reg.workspaces.filter((w) => w.id !== id);
      writeRegistry(reg);

      const dir = join(workspacesRoot(), id);
      let archived: string | null = null;
      let archiveError: string | null = null;
      try {
        const backupsDir = join(dir, 'backups');
        if (existsSync(backupsDir)) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const archiveDir = join(
            homedir(),
            '.papercusp-workspaces',
            '.archive',
            `${id}-${ts}`,
          );
          await fs.mkdir(join(workspacesRoot(), '.archive'), {
            recursive: true,
          });
          await fs.rename(backupsDir, archiveDir);
          archived = archiveDir;
        }
      } catch (err) {
        archiveError = err instanceof Error ? err.message : String(err);
      }
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* leak ok */
      }
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        const { sql } = getOrgPg();
        await sql`DELETE FROM harness_shared.backup_snapshots WHERE workspace_id = ${id}`;
        await sql`DELETE FROM harness_shared.workspace_backup_settings WHERE workspace_id = ${id}`;
      } catch {
        /* PG cleanup best-effort */
      }
      return Response.json({ ok: true, id, archived, archiveError });
    },
  }),
];
