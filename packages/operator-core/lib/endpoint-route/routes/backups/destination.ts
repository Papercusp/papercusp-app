/**
 * PUT  /api/backups/destination — set destination config.
 * POST /api/backups/destination/test — dry-run sync to verify connectivity.
 *
 * Ported from app/api/backups/destination/route.ts + app/api/backups/destination/test/route.ts.
 * `auth: 'loopback'` (auth-tier Wave 1).
 */
import { z } from 'zod';
import { workspaceBackupFor } from '../../../backup';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const S3Schema = z.object({
  bucket: z.string().min(1),
  prefix: z.string().optional(),
  endpoint: z.string().optional(),
  region: z.string().optional(),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().optional(),
});
const B2Schema = z.object({
  bucket: z.string().min(1),
  prefix: z.string().optional(),
  keyId: z.string().min(1),
  key: z.string().min(1),
});
const RcloneSchema = z.object({ remotePath: z.string().min(1) });

const Body = z.object({
  type: z.enum(['local', 'local+s3', 'local+b2', 'local+rclone']),
  config: z.union([S3Schema, B2Schema, RcloneSchema, z.null()]).optional(),
});

const put = defineTool({
  method: 'PUT',
  path: '/backups/destination',
  auth: 'loopback',
  async handler(req) {
    try {
      const body = await req.json();
      const { type, config } = Body.parse(body);
      const wb = workspaceBackupFor(activeWorkspaceId());
      await wb.setDestination(type, config ?? null);
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
    }
  },
});

const test = defineTool({
  method: 'POST',
  path: '/backups/destination/test',
  auth: 'loopback',
  async handler() {
    try {
      const wb = workspaceBackupFor(activeWorkspaceId());
      const result = await wb.testDestination();
      return Response.json({ result });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});

export default [put, test];
