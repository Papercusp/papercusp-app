/**
 * POST /api/admin/prune-executed-actions — delete executed_actions rows
 * older than `?days=30` across every per-harness schema.
 *
 * Ported from app/api/admin/prune-executed-actions/route.ts.
 * `auth: 'public'` — the route does its own Bearer-token auth.
 */
import { getOrgPg } from '@papercusp/db-org';
import { deriveCallerFromBearer } from '../../../execute-action';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/prune-executed-actions',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    const auth = await deriveCallerFromBearer(req.headers.get('authorization'));
    if (!auth.ok) {
      return Response.json({ ok: false, error: auth.error, detail: auth.detail }, { status: auth.status });
    }
    const url = new URL(req.url);
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') ?? 30)));
    const dryRun = url.searchParams.get('dryRun') === '1';

    const { sql } = getOrgPg();
    const schemas = await sql<{ nspname: string }[]>`
      SELECT nspname FROM pg_namespace
      WHERE nspname LIKE 'harness\\_%' AND nspname <> 'harness_shared'
    `;

    let totalDeleted = 0;
    const perSchema: { schema: string; deleted: number }[] = [];
    for (const { nspname } of schemas) {
      const exists = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM information_schema.tables
                      WHERE table_schema = ${nspname} AND table_name = 'executed_actions') AS exists
      `;
      if (!exists[0]?.exists) continue;

      if (dryRun) {
        const r = await sql.unsafe(
          `SELECT count(*)::int AS n FROM ${nspname}.executed_actions WHERE executed_at < now() - interval '${days} days'`,
        );
        const n = (r as any)[0]?.n ?? 0;
        perSchema.push({ schema: nspname, deleted: n });
        totalDeleted += n;
      } else {
        const r = await sql.unsafe(
          `DELETE FROM ${nspname}.executed_actions WHERE executed_at < now() - interval '${days} days' RETURNING action_id`,
        );
        const n = (r as any).length ?? 0;
        perSchema.push({ schema: nspname, deleted: n });
        totalDeleted += n;
      }
    }

    return Response.json({ ok: true, days, dryRun, totalDeleted, perSchema });
  },
});
