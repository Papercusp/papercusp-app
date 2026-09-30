/**
 * POST /api/internal/checkpoint-event — checkpoint persist.
 * Ported from app/api/internal/checkpoint-event/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const hc = generated.harnessCheckpointsInHarnessShared;

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_CONTENT = 64 * 1024;
const BodySchema = z.object({
  name: z.string().regex(NAME_RE),
  content: z.string().optional().default(''),
});

export default defineTool({
  method: 'POST',
  path: '/internal/checkpoint-event',
  auth: {},
  async handler(req) {
    const authHeader = req.headers.get('authorization') ?? '';
    const m = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (!m) return Response.json({ error: 'missing bearer' }, { status: 401 });
    const token = m[1];
    const { db } = getOrgPg();
    const rows = await db.select({ harness_slug: ti.harnessSlug }).from(ti).where(eq(ti.token, token)).limit(1);
    if (rows.length === 0) return Response.json({ error: 'invalid bearer' }, { status: 401 });
    const slug = rows[0].harness_slug;

    let raw: unknown;
    try { raw = await req.json(); } catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: 'validation failed', issues: parsed.error.issues }, { status: 400 });
    }
    const { name } = parsed.data;
    let content = parsed.data.content;
    if (Buffer.byteLength(content) > MAX_CONTENT) {
      content = content.slice(0, MAX_CONTENT) + '\n...[truncated]\n';
    }
    const waitingSinceMs = Date.now();
    const ws = activeWorkspaceId();
    await db.insert(hc).values({
      harnessSlug: slug, name, content, waitingSinceMs, granted: false, workspaceId: ws,
    }).onConflictDoUpdate({
      target: [hc.harnessSlug, hc.name],
      set: {
        content: dsql`EXCLUDED.content`,
        waitingSinceMs: dsql`EXCLUDED.waiting_since_ms`,
        granted: dsql`EXCLUDED.granted`,
        workspaceId: dsql`EXCLUDED.workspace_id`,
      },
    });
    void notifySyncInvalidate('harnessCheckpoints.byHarness', { harnessSlug: slug }).catch(() => {});
    return Response.json({ ok: true });
  },
});
