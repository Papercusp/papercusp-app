/**
 * GET /api/dev/tables
 *
 * Lists every table the Drizzle schema knows about. Source: runtime
 * introspection of `generated.*` via `getTableConfig`. Powers the
 * /dev "Tables" tab.
 *
 * Ported from app/api/dev/tables/route.ts. `auth: 'public'` —
 * faithful port at current posture (D3).
 */
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { is, Table } from 'drizzle-orm';
import { generated } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';

interface TableEntry {
  exportName: string;
  schema: string | undefined;
  name: string;
  columnCount: number;
  primaryKey: string[];
}

function listDrizzleTables(): TableEntry[] {
  const out: TableEntry[] = [];
  for (const [exportName, value] of Object.entries(generated)) {
    if (!value || typeof value !== 'object') continue;
    if (!is(value as object, Table)) continue;
    const cfg = getTableConfig(value as PgTable);
    const pkColumns = cfg.columns.filter((c) => c.primary).map((c) => c.name);
    const compositePk = cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name));
    out.push({
      exportName,
      schema: cfg.schema,
      name: cfg.name,
      columnCount: cfg.columns.length,
      primaryKey: pkColumns.length > 0 ? pkColumns : compositePk,
    });
  }
  out.sort((a, b) => {
    if (a.schema !== b.schema) return (a.schema ?? '').localeCompare(b.schema ?? '');
    return a.name.localeCompare(b.name);
  });
  return out;
}

export default defineTool({
  method: 'GET',
  path: '/dev/tables',
  auth: { trust: ['verified', 'trusted'] },
  async handler() {
    return Response.json({ tables: listDrizzleTables() });
  },
});
