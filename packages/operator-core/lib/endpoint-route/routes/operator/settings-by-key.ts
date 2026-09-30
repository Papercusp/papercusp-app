/**
 * GET /api/operator/settings/:key — one operator-wide setting from
 * harness_shared.operator_settings. 404 if absent.
 *
 * Ported from app/api/operator/settings/[key]/route.ts. `auth: 'public'`.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq } from 'drizzle-orm';
import { defineTool } from '@papercusp/agent-mcp';

const os = generated.operatorSettingsInHarnessShared;

export default defineTool({
  method: 'GET',
  path: '/operator/settings/:key',
  auth: 'public',
  async handler(_req, ctx) {
    const key = ctx.params.key as string;
    if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
      return Response.json({ error: 'invalid key' }, { status: 400 });
    }
    try {
      // `harness_shared.operator_settings` is migration-sourced (000-baseline.sql;
      // harness_app grants from migration 109) — no runtime ensure needed.
      const { db } = getOrgPg();
      const rows = await db
        .select({ key: os.key, value: os.value, description: os.description })
        .from(os)
        .where(eq(os.key, key))
        .limit(1);
      if (rows.length === 0) return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json(rows[0]);
    } catch (e: any) {
      return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
    }
  },
});
