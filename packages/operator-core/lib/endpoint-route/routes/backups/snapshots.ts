/**
 * GET  /api/backups/snapshots?limit=N — recent snapshots from PG.
 * POST /api/backups/snapshots — manually create one (with trace).
 *
 * Ported from app/api/backups/snapshots/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { workspaceBackupFor } from '../../../backup';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const PostSchema = z.object({
  reason: z.enum([
    'manual', 'interval', 'pre_destructive', 'post_run',
    'plugin_install', 'secret_change', 'startup',
  ]).default('manual'),
  context: z.record(z.string(), z.unknown()).optional(),
});

const get = defineTool({
  method: 'GET',
  path: '/backups/snapshots',
  auth: 'public',
  async handler(req) {
    try {
      const url = new URL(req.url);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
      const wb = workspaceBackupFor(activeWorkspaceId());
      const snapshots = await wb.list(limit);
      return Response.json({ snapshots });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});

const post = defineTool({
  method: 'POST',
  path: '/backups/snapshots',
  auth: 'loopback',
  async handler(req) {
    try {
      const body = await req.json().catch(() => ({}));
      const { reason, context } = PostSchema.parse(body);
      const wb = workspaceBackupFor(activeWorkspaceId());
      const start = Date.now();
      try {
        const result = await wb.snapshot(reason, context);
        const trace = {
          command: `WorkspaceBackup.snapshot(${reason})`,
          exitCode: 0,
          stdout: [
            `pre-snapshot hook: pg_dumpall :16534 → db-dumps/pg-embedded.sql.gz`,
            `kopia snapshot create ${result.kopiaSnapshotId.slice(0, 12)}…`,
            `bytes_added=${result.bytesAdded} duration=${result.durationMs}ms`,
            `→ backup_snapshots row id=${result.snapshotId}`,
          ].join('\n'),
          stderr: '',
          durationMs: Date.now() - start,
        };
        return Response.json({ result, trace });
      } catch (err) {
        const trace = {
          command: `WorkspaceBackup.snapshot(${reason})`,
          exitCode: 1,
          stdout: '',
          stderr: String(err instanceof Error ? err.message : err),
          durationMs: Date.now() - start,
        };
        return Response.json({ trace, error: trace.stderr }, { status: 500 });
      }
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});

export default [get, post];
