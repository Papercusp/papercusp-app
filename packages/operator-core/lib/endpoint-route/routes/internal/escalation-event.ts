/**
 * POST /api/internal/escalation-event — escalation/supervisor-notes persist.
 *
 * Ported from app/api/internal/escalation-event/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { notifyAttention } from '../../../attention-notify';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const he = generated.harnessEscalationsInHarnessShared;

const BodySchema = z
  .object({
    escalation: z.string().nullable().optional(),
    supervisorNotes: z.string().nullable().optional(),
    phase: z.enum(['staging', 'testing', 'production']).optional().default('staging'),
  })
  .refine((d) => d.escalation != null || d.supervisorNotes != null, {
    message: 'escalation or supervisorNotes required',
  });

const MAX_BODY = 256 * 1024;

export default defineTool({
  method: 'POST',
  path: '/internal/escalation-event',
  auth: {},
  async handler(req) {
    const authHeader = req.headers.get('authorization') ?? '';
    const m = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (!m) return Response.json({ error: 'missing bearer' }, { status: 401 });
    const token = m[1];

    const { db } = getOrgPg();
    const rows = await db
      .select({ harness_slug: ti.harnessSlug })
      .from(ti)
      .where(eq(ti.token, token))
      .limit(1);
    if (rows.length === 0) {
      return Response.json({ error: 'invalid bearer' }, { status: 401 });
    }
    const slug = rows[0].harness_slug;

    let raw: unknown;
    try { raw = await req.json(); }
    catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: 'validation failed', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { phase } = parsed.data;
    let escalation: string | null = parsed.data.escalation ?? null;
    let supervisorNotes: string | null = parsed.data.supervisorNotes ?? null;
    if (escalation && Buffer.byteLength(escalation) > MAX_BODY) {
      escalation = escalation.slice(0, MAX_BODY) + '\n...[truncated]\n';
    }
    if (supervisorNotes && Buffer.byteLength(supervisorNotes) > MAX_BODY) {
      supervisorNotes = supervisorNotes.slice(0, MAX_BODY) + '\n...[truncated]\n';
    }
    const mtimeMs = Date.now();
    const ws = activeWorkspaceId();

    await db
      .insert(he)
      .values({
        harnessSlug: slug,
        phase,
        escalation,
        supervisorNotes: supervisorNotes,
        mtimeMs: mtimeMs,
        workspaceId: ws,
      })
      .onConflictDoUpdate({
        target: [he.harnessSlug, he.phase],
        set: {
          escalation: dsql`COALESCE(${escalation}, ${he.escalation})`,
          supervisorNotes: dsql`COALESCE(${supervisorNotes}, ${he.supervisorNotes})`,
          mtimeMs: dsql`EXCLUDED.mtime_ms`,
          workspaceId: dsql`EXCLUDED.workspace_id`,
        },
      });
    void notifySyncInvalidate('harnessEscalations.byHarness', { harnessSlug: slug, phase }).catch(() => {});

    // P-021: push at the source (replaces the device-intervention-watcher
    // poll). A harness escalation is inherently high-importance → always
    // notify. Gated on `escalation != null` so a supervisorNotes-only update
    // doesn't ping. Fail-safe inside notifyAttention.
    if (escalation != null) {
      void notifyAttention({
        kind: 'intervention',
        title: 'Harness escalated',
        body: `${slug} (${phase}) needs your attention.`,
        harnessSlug: slug,
        importance: 'high',
        data: { phase },
      });
    }
    return Response.json({ ok: true });
  },
});
