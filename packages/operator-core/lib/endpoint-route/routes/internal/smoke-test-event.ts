/**
 * POST /api/internal/smoke-test-event — smoke test outcome persist.
 * Ported from app/api/internal/smoke-test-event/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { notifyAttention } from '../../../attention-notify';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const hs = generated.harnessSmokeTestInHarnessShared;

const BodySchema = z.object({
  status: z.enum(['pass', 'fail']),
  passContent: z.string().nullable().optional(),
  failureContent: z.string().nullable().optional(),
  results: z.unknown().optional(),
  startupLog: z.string().nullable().optional(),
  mtimeMs: z.number().int().nonnegative().optional(),
});

export default defineTool({
  method: 'POST',
  path: '/internal/smoke-test-event',
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
    const { status } = parsed.data;
    const passContent = parsed.data.passContent ?? null;
    const failureContent = parsed.data.failureContent ?? null;
    const startupLog = parsed.data.startupLog ?? null;
    const resultsJson = parsed.data.results == null ? null : JSON.stringify(parsed.data.results);
    const mtimeMs = parsed.data.mtimeMs ?? Date.now();
    const ws = activeWorkspaceId();
    // Read the prior status so we push only on a TRANSITION into failing
    // (pass→fail or first-ever fail), not on every re-run that stays failing.
    const priorRows = await db.select({ status: hs.status }).from(hs).where(eq(hs.harnessSlug, slug)).limit(1);
    const wasFailing = priorRows[0]?.status === 'fail';
    await db.insert(hs).values({
      harnessSlug: slug, status, passContent, failureContent,
      results: resultsJson ? (JSON.parse(resultsJson) as any) : null,
      startupLog, mtimeMs, workspaceId: ws,
    }).onConflictDoUpdate({
      target: hs.harnessSlug,
      set: {
        status: dsql`EXCLUDED.status`,
        passContent: dsql`EXCLUDED.pass_content`,
        failureContent: dsql`EXCLUDED.failure_content`,
        results: dsql`EXCLUDED.results`,
        startupLog: dsql`EXCLUDED.startup_log`,
        mtimeMs: dsql`EXCLUDED.mtime_ms`,
        workspaceId: dsql`EXCLUDED.workspace_id`,
      },
    });
    void notifySyncInvalidate('harnessSmokeTest.byHarness', { harnessSlug: slug }).catch(() => {});

    // P-021: push at the source (replaces the device-intervention-watcher
    // poll). Smoke failure is high-importance. Transition-gated so a smoke
    // run that stays failing doesn't re-ping each time.
    if (status === 'fail' && !wasFailing) {
      void notifyAttention({
        kind: 'smoke-fail',
        title: 'Smoke test failing',
        body: `${slug} smoke test is failing.`,
        harnessSlug: slug,
        importance: 'high',
      });
    }
    return Response.json({ ok: true });
  },
});
