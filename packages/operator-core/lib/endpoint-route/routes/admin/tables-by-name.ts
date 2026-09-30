/**
 * /api/admin/tables/:exportName — generic CRUD over an allowlisted table.
 *
 *   GET    ?limit=&offset=  — paginated list
 *   POST   { row }          — insert; validated against insertSchema
 *   PATCH  { pk, set }      — update by PK; `set` validated
 *   DELETE ?pk=<json>       — delete by PK
 *
 * Ported from app/api/admin/tables/[exportName]/route.ts. `auth:'public'`.
 * Always uses `harness_admin` (RLS bypass); the editable-column filter
 * prevents privilege escalation to sensitive columns.
 */
import { schemaOf, getOrgPg } from '@papercusp/db-org';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { getAdminTable } from '../../../admin-tables';
import { defineTool } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';

function pickEditable<T extends Record<string, unknown>>(
  obj: T,
  allowed: readonly string[] | undefined,
): T {
  if (!allowed) return obj;
  const out: Record<string, unknown> = {};
  for (const k of allowed) if (k in obj) out[k] = obj[k];
  return out as T;
}

function pkPredicate(table: PgTable, pkColumns: string[], pkValues: Record<string, unknown>) {
  const cfg = getTableConfig(table);
  const cols = cfg.columns;
  const preds = pkColumns.map((name) => {
    const col = cols.find((c) => c.name === name);
    if (!col) throw new Error(`unknown pk column ${name}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return eq(col as any, pkValues[name]);
  });
  return preds.length === 1 ? preds[0] : and(...preds);
}

function resolvePk(table: PgTable): string[] {
  const cfg = getTableConfig(table);
  const single = cfg.columns.filter((c) => c.primary).map((c) => c.name);
  if (single.length) return single;
  return cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name));
}

const get = defineTool({
  method: 'GET',
  path: '/admin/tables/:exportName',
  // unverified-loopback: cookie-less desktop webview (EI-338) — see admin/tables.ts.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req, ctx) {
    const { exportName } = ctx.params;
    const entry = getAdminTable(exportName);
    if (!entry) return Response.json({ error: 'unknown admin table' }, { status: 404 });
    const table = entry.table as unknown as PgTable;
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50'), 1), 500);
    const offset = Math.max(Number(url.searchParams.get('offset') ?? '0'), 0);
    const cfg = getTableConfig(table);
    const qualified = cfg.schema ? `${cfg.schema}.${cfg.name}` : cfg.name;
    const { db, sql } = getOrgPg();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await db.select().from(table as any).limit(limit).offset(offset);
    const c = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM ${sql.unsafe(qualified)}`;
    return Response.json({ rows, total: Number(c[0]?.n ?? '0'), limit, offset });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/admin/tables/:exportName',
  // unverified-loopback: cookie-less desktop webview (EI-338) — see admin/tables.ts.
  // State-mutating, so also CSRF-gated below (requireAllowedOriginOr403).
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req, ctx) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const { exportName } = ctx.params;
    const entry = getAdminTable(exportName);
    if (!entry) return Response.json({ error: 'unknown admin table' }, { status: 404 });
    const table = entry.table as unknown as PgTable;
    let body: unknown;
    try { body = await req.json(); }
    catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }

    const insert = schemaOf(entry.table).insert;
    const filtered = pickEditable(body as Record<string, unknown>, entry.editableColumns);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = (insert as any).safeParse(filtered);
    if (!parsed.success) {
      return Response.json(
        { error: 'validation failed', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { db } = getOrgPg();
    const pkColumns = resolvePk(table);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inserted = await (db.insert(table as any).values(parsed.data as any).returning()) as Array<Record<string, unknown>>;
    return Response.json({ row: inserted[0] ?? null, pk: pkColumns });
  },
});

const patch = defineTool({
  method: 'PATCH',
  path: '/admin/tables/:exportName',
  // unverified-loopback: cookie-less desktop webview (EI-338) — see admin/tables.ts.
  // State-mutating, so also CSRF-gated below (requireAllowedOriginOr403).
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req, ctx) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const { exportName } = ctx.params;
    const entry = getAdminTable(exportName);
    if (!entry) return Response.json({ error: 'unknown admin table' }, { status: 404 });
    const table = entry.table as unknown as PgTable;
    let body: { pk?: Record<string, unknown>; set?: Record<string, unknown> };
    try { body = await req.json(); }
    catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }

    const pkColumns = resolvePk(table);
    if (!body.pk || pkColumns.some((c) => !(c in body.pk!))) {
      return Response.json({ error: 'missing pk', pkColumns }, { status: 400 });
    }
    const update = schemaOf(entry.table).update;
    const filtered = pickEditable(body.set ?? {}, entry.editableColumns);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = (update as any).safeParse(filtered);
    if (!parsed.success) {
      return Response.json(
        { error: 'validation failed', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    if (Object.keys(parsed.data).length === 0) {
      return Response.json({ error: 'no editable fields set' }, { status: 400 });
    }
    const { db } = getOrgPg();
    const pred = pkPredicate(table, pkColumns, body.pk);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = await (db.update(table as any).set(parsed.data as any).where(pred as any).returning()) as Array<Record<string, unknown>>;
    return Response.json({ row: updated[0] ?? null });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/admin/tables/:exportName',
  // unverified-loopback: cookie-less desktop webview (EI-338) — see admin/tables.ts.
  // State-mutating, so also CSRF-gated below (requireAllowedOriginOr403).
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req, ctx) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const { exportName } = ctx.params;
    const entry = getAdminTable(exportName);
    if (!entry) return Response.json({ error: 'unknown admin table' }, { status: 404 });
    if (entry.allowDelete === false) {
      return Response.json({ error: 'delete disabled for this table' }, { status: 403 });
    }
    const table = entry.table as unknown as PgTable;
    const url = new URL(req.url);
    const pkRaw = url.searchParams.get('pk');
    if (!pkRaw) return Response.json({ error: 'missing pk query' }, { status: 400 });
    let pkObj: Record<string, unknown>;
    try { pkObj = JSON.parse(pkRaw); }
    catch { return Response.json({ error: 'pk must be JSON' }, { status: 400 }); }
    const pkColumns = resolvePk(table);
    const pred = pkPredicate(table, pkColumns, pkObj);
    const { db } = getOrgPg();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleted = await (db.delete(table as any).where(pred as any).returning()) as Array<Record<string, unknown>>;
    return Response.json({ deleted: deleted.length, rows: deleted });
  },
});

// Keep dsql import alive so future composite-PK shapes can reuse it.
void dsql;

export default [get, post, patch, del];
