/**
 * POST /api/internal/run-chunk — orchestrator subprocess stdout chunk.
 *
 * Ported from app/api/internal/run-chunk/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq } from 'drizzle-orm';
import { publish, closeChannel } from '../../../run-chunk-bus';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const RUN_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_CHUNK_BYTES = 256 * 1024;

const BodySchema = z.object({
  runId: z.string().regex(RUN_ID_RE),
  seq: z.number().int().nonnegative(),
  chunk: z.string(),
  done: z.boolean().optional().default(false),
});

export default defineTool({
  method: 'POST',
  path: '/internal/run-chunk',
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
    const harnessSlug = rows[0].harness_slug;

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
    const { runId, seq, chunk, done } = parsed.data;

    if (Buffer.byteLength(chunk) > MAX_CHUNK_BYTES) {
      return Response.json({ error: 'chunk too large' }, { status: 413 });
    }

    const channelKey = `${harnessSlug}:${runId}`;
    publish(channelKey, seq, chunk);
    if (done) closeChannel(channelKey);

    return Response.json({ ok: true });
  },
});
