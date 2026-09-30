/**
 * GET /api/user-actions/:slug/:id/log — run-log body for one user-action.
 * Path-traversal-guarded: the row's detail_url must resolve inside the
 * harness project dir.
 *
 * Ported from app/api/user-actions/[slug]/[id]/log/route.ts. `auth: 'public'`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq } from 'drizzle-orm';
import { loadHarnessRegistry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

const ua = generated.userActionsInHarnessShared;
const MAX_BYTES = 2 * 1024 * 1024;

export default defineTool({
  method: 'GET',
  path: '/user-actions/:slug/:id/log',
  auth: 'public',
  async handler(_req, ctx) {
    const { slug, id } = ctx.params;
    const numericId = Number(id);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return Response.json({ error: 'invalid id' }, { status: 400 });
    }
    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) return Response.json({ error: 'unknown harness' }, { status: 404 });

    const { db } = getOrgPg();
    const rows = await db
      .select({ detail_url: ua.detailUrl, kind: ua.kind, status: ua.status })
      .from(ua)
      .where(and(eq(ua.harnessSlug, slug), eq(ua.id, BigInt(numericId))))
      .limit(1);
    if (rows.length === 0) return Response.json({ error: 'not found' }, { status: 404 });
    const detailUrl = rows[0].detail_url;
    if (!detailUrl) {
      return Response.json({ error: 'no detail url for this user_action' }, { status: 404 });
    }

    const projectRoot = resolve(project.path);
    const target = resolve(detailUrl);
    if (!target.startsWith(projectRoot + '/') && target !== projectRoot) {
      return Response.json({ error: 'detail url outside harness root' }, { status: 403 });
    }
    if (!existsSync(target)) {
      return Response.json({ error: 'log file missing on disk', path: target }, { status: 404 });
    }
    let content = '';
    try {
      const st = statSync(target);
      if (st.size > MAX_BYTES) {
        const fd = readFileSync(target);
        content =
          `… (truncated ${st.size - MAX_BYTES} earlier bytes)\n` +
          fd.subarray(fd.length - MAX_BYTES).toString('utf8');
      } else {
        content = readFileSync(target, 'utf8');
      }
    } catch (e) {
      return Response.json(
        { error: 'read failed', detail: String((e as Error)?.message ?? e) },
        { status: 500 },
      );
    }
    return new Response(content, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-user-action-id': String(numericId),
        'x-user-action-status': rows[0].status,
        'x-user-action-kind': rows[0].kind,
      },
    });
  },
});
