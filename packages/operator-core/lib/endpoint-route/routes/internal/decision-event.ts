/**
 * POST /api/internal/decision-event — ORCH decision line persist.
 *
 * Ported from app/api/internal/decision-event/route.ts. `auth: 'public'`.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const hd = generated.harnessDecisionsInHarnessShared;

const BodySchema = z.object({
  iso: z.string().min(1),
  verb: z.string().min(1),
  args: z.string().optional().default(''),
  iteration: z.number().int().nullable().optional().default(null),
  isGhost: z.boolean().optional().default(false),
});

export default defineTool({
  method: 'POST',
  path: '/internal/decision-event',
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
    const { iso, verb, args, iteration, isGhost } = parsed.data;
    const ts = Date.parse(iso);
    const lineHash = createHash('sha1').update(`${iso}|${verb}|${args}`).digest('hex');

    const ws = activeWorkspaceId();
    await db
      .insert(hd)
      .values({
        harnessSlug: slug,
        lineHash: lineHash,
        ts: Number.isNaN(ts) ? 0 : ts,
        iso,
        verb,
        args,
        iteration,
        isGhost: isGhost,
        workspaceId: ws,
      })
      .onConflictDoUpdate({
        target: [hd.harnessSlug, hd.lineHash],
        set: {
          ts: dsql`EXCLUDED.ts`,
          iso: dsql`EXCLUDED.iso`,
          verb: dsql`EXCLUDED.verb`,
          args: dsql`EXCLUDED.args`,
          iteration: dsql`EXCLUDED.iteration`,
          isGhost: dsql`EXCLUDED.is_ghost`,
          workspaceId: dsql`EXCLUDED.workspace_id`,
        },
      });
    void notifySyncInvalidate('harnessDecisions.byHarness', { harnessSlug: slug }).catch(() => {});

    return Response.json({ ok: true });
  },
});
