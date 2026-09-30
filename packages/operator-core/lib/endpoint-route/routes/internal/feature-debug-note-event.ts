/**
 * POST /api/internal/feature-debug-note-event — feature debug-note persist.
 * Ported from app/api/internal/feature-debug-note-event/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const fdn = generated.harnessFeatureDebugNotesInHarnessShared;

const BodySchema = z.object({
  featureId: z.string().min(1),
  content: z.string().optional().default(''),
  mtimeMs: z.number().int().nonnegative().optional().default(() => Date.now()),
});

export default defineTool({
  method: 'POST',
  path: '/internal/feature-debug-note-event',
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
    const { featureId, content, mtimeMs } = parsed.data;
    const ws = activeWorkspaceId();
    if (content === '') {
      await db.delete(fdn).where(and(eq(fdn.workspaceId, ws), eq(fdn.harnessSlug, slug), eq(fdn.featureId, featureId)));
    } else {
      await db.insert(fdn).values({
        workspaceId: ws, harnessSlug: slug, featureId, content, mtimeMs,
      }).onConflictDoUpdate({
        target: [fdn.workspaceId, fdn.harnessSlug, fdn.featureId],
        set: { content: dsql`EXCLUDED.content`, mtimeMs: dsql`EXCLUDED.mtime_ms` },
      });
    }
    void notifySyncInvalidate('featureDebugNotes.byHarness', { harnessSlug: slug }).catch(() => {});
    return Response.json({ ok: true });
  },
});
