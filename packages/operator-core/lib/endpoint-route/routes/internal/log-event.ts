/**
 * POST /api/internal/log-event — bash run.sh log() forwarding.
 *
 * Ported from app/api/internal/log-event/route.ts. `auth: 'public'` —
 * harness-token bearer check inline.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq } from 'drizzle-orm';
import { publish } from '../../../harness-log-bus';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const KIND_RE = /^(log|raw)$/;
const MAX_LINE_BYTES = 64 * 1024;

interface RequestBody {
  kind?: string;
  line?: string;
  raw?: string;
  log?: string;
}

export default defineTool({
  method: 'POST',
  path: '/internal/log-event',
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

    let body: RequestBody;
    try { body = (await req.json()) as RequestBody; }
    catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }

    let logLine: string | null = null;
    let rawLine: string | null = null;

    if (typeof body.kind === 'string' && KIND_RE.test(body.kind)) {
      if (typeof body.line !== 'string') {
        return Response.json({ error: 'invalid line' }, { status: 400 });
      }
      if (body.kind === 'log') logLine = body.line;
      else rawLine = body.line;
    } else {
      if (typeof body.log === 'string') logLine = body.log;
      if (typeof body.raw === 'string') rawLine = body.raw;
    }
    if (logLine === null && rawLine === null) {
      return Response.json({ error: 'no line payload' }, { status: 400 });
    }
    for (const v of [logLine, rawLine]) {
      if (v !== null && Buffer.byteLength(v) > MAX_LINE_BYTES) {
        return Response.json({ error: 'line too large' }, { status: 413 });
      }
    }

    if (logLine !== null) publish(`${slug}:log`, logLine);
    if (rawLine !== null) publish(`${slug}:raw`, rawLine);

    return Response.json({ ok: true });
  },
});
