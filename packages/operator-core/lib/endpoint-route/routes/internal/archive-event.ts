/**
 * POST /api/internal/archive-event — archive metadata persist.
 * Ported from app/api/internal/archive-event/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { getOrgPg, generated, schemaOf } from '@papercusp/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const ha = generated.harnessArchivesInHarnessShared;

const BodySchema = z.object({
  id: z.string().min(1).endsWith('.tar.gz'),
  sizeBytes: z.number().int().nonnegative().optional().default(0),
  ts: z.number().int().nonnegative().optional().default(() => Date.now()),
  phase: z.enum(['staging', 'testing', 'production']).optional().default('staging'),
});
void schemaOf(ha).insert;

export default defineTool({
  method: 'POST',
  path: '/internal/archive-event',
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
    const { id, sizeBytes, ts, phase } = parsed.data;
    const ws = activeWorkspaceId();
    await db.insert(ha).values({
      harnessSlug: slug, phase, id, sizeBytes, ts, workspaceId: ws,
    }).onConflictDoUpdate({
      target: [ha.harnessSlug, ha.phase, ha.id],
      set: { sizeBytes: dsql`EXCLUDED.size_bytes`, ts: dsql`EXCLUDED.ts`, workspaceId: dsql`EXCLUDED.workspace_id` },
    });
    void notifySyncInvalidate('harnessArchives.byHarness', { harnessSlug: slug, phase }).catch(() => {});
    return Response.json({ ok: true });
  },
});
