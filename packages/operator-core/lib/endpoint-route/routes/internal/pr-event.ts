/**
 * POST /api/internal/pr-event — PR url/state persist.
 * Ported from app/api/internal/pr-event/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const fp = generated.harnessFeaturePrsInHarnessShared;

const BodySchema = z.object({
  featureId: z.string().min(1),
  url: z.string().min(1),
  state: z.string().optional().default('unknown'),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
});

export default defineTool({
  method: 'POST',
  path: '/internal/pr-event',
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
    const { featureId, url, state } = parsed.data;
    const createdAt = parsed.data.createdAt ?? Math.floor(Date.now() / 1000);
    const updatedAt = parsed.data.updatedAt ?? createdAt;
    const ws = activeWorkspaceId();
    await db.insert(fp).values({
      workspaceId: ws, harnessSlug: slug, featureId, prUrl: url, prState: state,
      openedTs: createdAt, updatedTs: updatedAt,
    }).onConflictDoUpdate({
      target: [fp.workspaceId, fp.harnessSlug, fp.featureId],
      set: {
        prUrl: dsql`EXCLUDED.pr_url`, prState: dsql`EXCLUDED.pr_state`,
        openedTs: dsql`EXCLUDED.opened_ts`, updatedTs: dsql`EXCLUDED.updated_ts`,
      },
    });
    void notifySyncInvalidate('featurePrs.byHarness', { harnessSlug: slug }).catch(() => {});
    return Response.json({ ok: true });
  },
});
