/**
 * GET /api/dev/tables/:exportName/rows
 *
 * Paginated rows for a drizzle table. RLS-aware: uses getOrgPg().db
 * (admin role, RLS bypass) by default; `?role=app` switches to the
 * workspace-scoped app role. Supports `?where=` equality filters and
 * `?filters=` triples for other ops (eq/ne/gt/lt/like/ilike/in/isnull/…).
 *
 * Ported from app/api/dev/tables/[exportName]/rows/route.ts.
 * `auth: 'public'` — faithful port at current posture (D3).
 */
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  and, eq, ne, gt, lt, gte, lte, like, ilike, inArray, notInArray,
  isNull, isNotNull, is, Table, type SQL,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getOrgPg, generated, withWorkspaceQuery } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

type Op =
  | 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte'
  | 'like' | 'ilike' | 'in' | 'notin' | 'isnull' | 'notnull';
const VALUELESS_OPS: ReadonlySet<Op> = new Set(['isnull', 'notnull']);
const SUPPORTED_OPS: ReadonlySet<Op> = new Set([
  'eq', 'ne', 'gt', 'lt', 'gte', 'lte',
  'like', 'ilike', 'in', 'notin', 'isnull', 'notnull',
]);

function tableByExportName(exportName: string): PgTable | null {
  const value = (generated as Record<string, unknown>)[exportName];
  if (!value || typeof value !== 'object') return null;
  if (!is(value as object, Table)) return null;
  return value as PgTable;
}

function parseJsonParam<T>(raw: string | null, guard: (v: unknown) => v is T): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function applyOp(col: unknown, op: Op, value: unknown): SQL | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = col as any;
  switch (op) {
    case 'eq': return eq(c, value);
    case 'ne': return ne(c, value);
    case 'gt': return gt(c, value);
    case 'lt': return lt(c, value);
    case 'gte': return gte(c, value);
    case 'lte': return lte(c, value);
    case 'like': return like(c, String(value));
    case 'ilike': return ilike(c, String(value));
    case 'in':
      return Array.isArray(value) && value.length > 0 ? inArray(c, value) : null;
    case 'notin':
      return Array.isArray(value) && value.length > 0 ? notInArray(c, value) : null;
    case 'isnull': return isNull(c);
    case 'notnull': return isNotNull(c);
    default: return null;
  }
}

function buildPredicate(
  table: PgTable,
  where: Record<string, unknown> | null,
  filters: Array<[string, string, unknown]> | null,
): SQL | undefined {
  const cfg = getTableConfig(table);
  const colByName = new Map(cfg.columns.map((c) => [c.name, c]));
  const preds: SQL[] = [];

  if (where) {
    for (const [name, value] of Object.entries(where)) {
      const col = colByName.get(name);
      if (!col) continue;
      const p = applyOp(col, 'eq', value);
      if (p) preds.push(p);
    }
  }
  if (filters) {
    for (const triple of filters) {
      if (!Array.isArray(triple) || triple.length < 2) continue;
      const [name, opRaw, value] = triple;
      if (typeof name !== 'string' || typeof opRaw !== 'string') continue;
      const op = opRaw as Op;
      if (!SUPPORTED_OPS.has(op)) continue;
      const col = colByName.get(name);
      if (!col) continue;
      const p = applyOp(col, op, VALUELESS_OPS.has(op) ? null : value);
      if (p) preds.push(p);
    }
  }
  if (preds.length === 0) return undefined;
  return preds.length === 1 ? preds[0] : and(...preds);
}

export default defineTool({
  method: 'GET',
  path: '/dev/tables/:exportName/rows',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req, ctx) {
    const { exportName } = ctx.params;
    const table = tableByExportName(exportName);
    if (!table) return Response.json({ error: 'unknown table export' }, { status: 404 });
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50'), 1), 500);
    const offset = Math.max(Number(url.searchParams.get('offset') ?? '0'), 0);
    const role = url.searchParams.get('role') === 'app' ? 'app' : 'admin';
    const whereObj = parseJsonParam<Record<string, unknown>>(
      url.searchParams.get('where'),
      (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v),
    );
    const filtersArr = parseJsonParam<Array<[string, string, unknown]>>(
      url.searchParams.get('filters'),
      (v): v is Array<[string, string, unknown]> => Array.isArray(v),
    );
    const wherePred = buildPredicate(table, whereObj, filtersArr);

    const cfg = getTableConfig(table);
    const qualified = cfg.schema ? `${cfg.schema}.${cfg.name}` : cfg.name;

    try {
      let rows: unknown[];
      let total: number | null = null;
      if (role === 'app') {
        const ws = activeWorkspaceId();
        const result = await withWorkspaceQuery(ws, async (tx) => {
          const txDb = drizzle(tx);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const q = txDb.select().from(table as any);
          const r = await (wherePred ? q.where(wherePred as any).limit(limit).offset(offset) : q.limit(limit).offset(offset));
          if (wherePred) return { rows: r, n: r.length };
          const c = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM ${tx.unsafe(qualified)}`;
          return { rows: r, n: Number(c[0]?.n ?? '0') };
        });
        rows = result.rows;
        total = result.n;
      } else {
        const { db, sql } = getOrgPg();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const q = db.select().from(table as any);
        rows = await (wherePred ? q.where(wherePred as any).limit(limit).offset(offset) : q.limit(limit).offset(offset));
        if (wherePred) {
          total = (rows as unknown[]).length;
        } else {
          const c = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM ${sql.unsafe(qualified)}`;
          total = Number(c[0]?.n ?? '0');
        }
      }

      const safeRows = rows.map((r) => {
        const obj = r as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (v instanceof Date) out[k] = v.toISOString();
          else if (typeof v === 'bigint') out[k] = Number(v);
          else out[k] = v;
        }
        return out;
      });

      return Response.json({
        rows: safeRows,
        total,
        limit,
        offset,
        role,
        qualifiedName: qualified,
        filtered: !!wherePred,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg, qualifiedName: qualified, role }, { status: 500 });
    }
  },
});
