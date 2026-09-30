/**
 * POST /api/plugins/host/query — read-only PG query for iframe plugin surfaces.
 * SELECT-only; search_path scoped to plugin_<name>.
 * Ported from app/api/plugins/host/query/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';

interface ReqBody {
  pluginName: string;
  installSlug: string;
  query: string;
}

const SELECT_ONLY = /^\s*select\b/i;

export default defineTool({
  method: 'POST',
  path: '/plugins/host/query',
  auth: 'loopback',
  async handler(req) {
    let body: ReqBody;
    try {
      body = (await req.json()) as ReqBody;
    } catch {
      return Response.json({ rows: [], error: 'invalid JSON' }, { status: 400 });
    }
    if (!body.pluginName || !body.installSlug || !body.query) {
      return Response.json(
        { rows: [], error: 'pluginName, installSlug, query required' },
        { status: 400 },
      );
    }
    if (!SELECT_ONLY.test(body.query)) {
      return Response.json(
        { rows: [], error: 'only SELECT queries are permitted via this endpoint' },
        { status: 400 },
      );
    }

    try {
      const { sql } = getOrgPg();
      const schema = `plugin_${body.pluginName.replace(/[^a-z0-9_]/gi, '_')}`;
      const limited = /\blimit\b/i.test(body.query) ? body.query : `${body.query.replace(/;\s*$/, '')} LIMIT 1000`;
      // `SET LOCAL` only lives for the transaction that issues it, so the
      // search_path prefix and the SELECT MUST share one tx. (The
      // pre-migration route called `pg.query()` — a node-postgres API
      // `getOrgPg()` never exposed; it returns a postgres-js handle.)
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path = ${schema}, public`);
        return tx.unsafe(limited);
      });
      return Response.json({ rows: rows ?? [] });
    } catch (e: unknown) {
      return Response.json(
        { rows: [], error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  },
});
