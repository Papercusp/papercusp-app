/**
 * GET /api/dev/tables/:exportName
 *
 * Detailed schema info for one drizzle-introspected table: columns
 * (name + dataType + notNull + primary + hasDefault + default), indexes,
 * foreign keys, primary key.
 *
 * Ported from app/api/dev/tables/[exportName]/route.ts.
 * `auth: 'public'` — faithful port at current posture (D3).
 */
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { is, Table } from 'drizzle-orm';
import { generated } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';

function tableByExportName(exportName: string): PgTable | null {
  const value = (generated as Record<string, unknown>)[exportName];
  if (!value || typeof value !== 'object') return null;
  if (!is(value as object, Table)) return null;
  return value as PgTable;
}

interface ColumnSummary {
  name: string;
  dataType: string;
  columnType: string;
  notNull: boolean;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  isUnique: boolean;
  generated: boolean;
}

export default defineTool({
  method: 'GET',
  path: '/dev/tables/:exportName',
  // unverified-loopback: cookie-less desktop webview (EI-338) — the TableAdmin
  // pane's detail fetch hits this alongside admin/tables/:exportName; without
  // this the pane's Promise.all still 403s even after admin/tables.ts is fixed
  // (EI-18834967602055309). Read-only schema introspection.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(_req, ctx) {
    const { exportName } = ctx.params;
    const table = tableByExportName(exportName);
    if (!table) return Response.json({ error: 'unknown table export' }, { status: 404 });
    const cfg = getTableConfig(table);

    const columns: ColumnSummary[] = cfg.columns.map((c) => ({
      name: c.name,
      dataType: (c as { dataType?: string }).dataType ?? c.columnType,
      columnType: c.columnType,
      notNull: c.notNull,
      primary: c.primary,
      hasDefault: c.hasDefault,
      default: typeof c.default === 'function' ? '<function>' : (c.default ?? null),
      isUnique: (c as { isUnique?: boolean }).isUnique ?? false,
      generated: Boolean((c as { generated?: unknown }).generated),
    }));

    const pkColumns = cfg.columns.filter((c) => c.primary).map((c) => c.name);
    const compositePk = cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name));

    return Response.json({
      exportName,
      schema: cfg.schema,
      name: cfg.name,
      qualifiedName: cfg.schema ? `${cfg.schema}.${cfg.name}` : cfg.name,
      columns,
      primaryKey: pkColumns.length > 0 ? pkColumns : compositePk,
      indexes: cfg.indexes.map((i) => ({
        name: (i as { config?: { name?: string } }).config?.name ?? '<unnamed>',
        columns: ((i as { config?: { columns?: Array<{ name?: string }> } }).config?.columns ?? [])
          .map((c) => c.name ?? '<expr>'),
      })),
      foreignKeys: cfg.foreignKeys.map((fk) => {
        const ref = fk.reference();
        const ft = ref.foreignTable as unknown as { [k: symbol]: string };
        const ftName = ft[Symbol.for('drizzle:Name')];
        const ftSchema = ft[Symbol.for('drizzle:Schema')];
        return {
          columns: ref.columns.map((c) => c.name),
          foreignColumns: ref.foreignColumns.map((c) => c.name),
          foreignTable: ftSchema ? `${ftSchema}.${ftName}` : ftName,
        };
      }),
    });
  },
});
