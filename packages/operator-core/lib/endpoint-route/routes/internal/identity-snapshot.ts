/**
 * POST /api/internal/identity-snapshot — identity/<role>.md upserts.
 * Ported from app/api/internal/identity-snapshot/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const idf = generated.identityFilesInHarnessShared;

const ROLE_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
const MAX_BODY = 256 * 1024;
const FileEntrySchema = z.object({ role: z.string().regex(ROLE_RE), content: z.string().optional().default('') });
const BodySchema = z.object({ files: z.array(FileEntrySchema).optional().default([]) });

export default defineTool({
  method: 'POST',
  path: '/internal/identity-snapshot',
  auth: {},
  async handler(req) {
    const authHeader = req.headers.get('authorization') ?? '';
    const m = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (!m) return Response.json({ error: 'missing bearer' }, { status: 401 });
    const token = m[1];
    const { db } = getOrgPg();
    const tokenRows = await db.select({ harness_slug: ti.harnessSlug }).from(ti).where(eq(ti.token, token)).limit(1);
    if (tokenRows.length === 0) return Response.json({ error: 'invalid bearer' }, { status: 401 });

    let raw: unknown;
    try { raw = await req.json(); } catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: 'validation failed', issues: parsed.error.issues }, { status: 400 });
    }
    const { files } = parsed.data;
    const ws = activeWorkspaceId();
    const now = Date.now();
    let upserts = 0; let deletes = 0;
    for (const f of files) {
      let content = f.content;
      if (Buffer.byteLength(content) > MAX_BODY) {
        content = content.slice(0, MAX_BODY) + '\n...[truncated]\n';
      }
      if (content === '') {
        await db.delete(idf).where(eq(idf.role, f.role));
        deletes++;
      } else {
        const bytes = Buffer.byteLength(content);
        await db.insert(idf).values({
          role: f.role, content, bytes, mtimeMs: now, updatedAt: now, workspaceId: ws,
        }).onConflictDoUpdate({
          target: idf.role,
          set: {
            content: dsql`EXCLUDED.content`, bytes: dsql`EXCLUDED.bytes`,
            mtimeMs: dsql`EXCLUDED.mtime_ms`, updatedAt: dsql`EXCLUDED.updated_at`,
            workspaceId: dsql`EXCLUDED.workspace_id`,
          },
        });
        upserts++;
      }
    }
    void notifySyncInvalidate('harnessIdentity').catch(() => {});
    return Response.json({ ok: true, upserts, deletes });
  },
});
