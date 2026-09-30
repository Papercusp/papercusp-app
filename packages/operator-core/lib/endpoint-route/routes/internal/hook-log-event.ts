/**
 * POST /api/internal/hook-log-event — per-hook execution metadata persist, cap 50.
 * Ported from app/api/internal/hook-log-event/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, desc, eq, notInArray, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const hl = generated.harnessHookLogsInHarnessShared;

const HOOK_KEEP = 50;
const BodySchema = z.object({
  name: z.string().min(1),
  ts: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative().optional().default(0),
});

export default defineTool({
  method: 'POST',
  path: '/internal/hook-log-event',
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
    const { name, sizeBytes } = parsed.data;
    const tsSec = Math.floor(parsed.data.ts);
    const logId = `${tsSec}-${name}`;
    const tsMs = tsSec * 1000;
    const ws = activeWorkspaceId();
    await db.insert(hl).values({
      harnessSlug: slug, logId, name, ts: tsMs, sizeBytes, workspaceId: ws,
    }).onConflictDoUpdate({
      target: [hl.harnessSlug, hl.logId],
      set: {
        name: dsql`EXCLUDED.name`, ts: dsql`EXCLUDED.ts`,
        sizeBytes: dsql`EXCLUDED.size_bytes`,
        workspaceId: dsql`EXCLUDED.workspace_id`,
      },
    });
    const keepers = await db.select({ logId: hl.logId }).from(hl).where(eq(hl.harnessSlug, slug)).orderBy(desc(hl.ts)).limit(HOOK_KEEP);
    if (keepers.length > 0) {
      await db.delete(hl).where(and(eq(hl.harnessSlug, slug), notInArray(hl.logId, keepers.map((k) => k.logId))));
    }
    void notifySyncInvalidate('harnessHookLogs.byHarness', { harnessSlug: slug }).catch(() => {});
    return Response.json({ ok: true });
  },
});
