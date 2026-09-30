/**
 * POST /api/dev/sql — read-only SQL playground (Unlock 2: Monaco composer).
 *
 * Runs free-form SQL inside a transaction with the harness_admin pool
 * (default) or the harness_app pool with workspace GUC set (role=app).
 * Wrapped in a 10s statement_timeout and rolled back at the end so even
 * read-only-by-name statements with side-effects can't escape the
 * connection.
 *
 * Safety gate: only SELECT/WITH/EXPLAIN/SHOW/TABLE/VALUES allowed.
 *
 * Ported from app/api/dev/sql/route.ts. `auth: 'public'` — dev tool,
 * faithful port at current posture (D3 — flagged for auth-tightening).
 */
import { z } from 'zod';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

import { stripSqlCommentsAndStrings } from '../../../../../../scripts/lib/strip-comments-and-strings.mjs';

const BodySchema = z.object({
  sql: z.string().min(1).max(64 * 1024),
  role: z.enum(['admin', 'app']).optional().default('admin'),
});

const STATEMENT_TIMEOUT_MS = 10_000;
const MAX_ROWS_RETURNED = 1000;
const ALLOWED_LEADING = new Set(['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'TABLE', 'VALUES']);

/**
 * Data-modifying keywords that must never appear as bare tokens inside an
 * otherwise-allowed read-only statement. The leading-keyword gate alone is
 * NOT enough: PostgreSQL lets a data-modifying statement hide behind an
 * allowed leader, most notably a data-modifying CTE
 * (`WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x` — leader is the
 * accepted `WITH`, but the DELETE still runs). `EXPLAIN ANALYZE <mutation>`
 * and a `TABLE`/`VALUES`/`SELECT` body that splices a writable CTE are the
 * same class of bypass. We strip strings / comments / dollar-quotes first,
 * so these only match real SQL keywords, never a literal or identifier.
 */
const FORBIDDEN_INNER = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'GRANT', 'REVOKE'];
const FORBIDDEN_INNER_RE = new RegExp(`\\b(?:${FORBIDDEN_INNER.join('|')})\\b`, 'i');

/**
 * Strip the parts of a statement that can legitimately contain
 * SQL-keyword-looking text — single-quoted strings, double-quoted
 * identifiers, dollar-quoted strings, and `--` / block comments — so the
 * residue is the bare SQL skeleton safe to keyword-scan. Mirrors the
 * quoting rules `splitStatements` already understands.
 *
 * Delegates to the canonical shared mask (EI-20073035509369492). This was the LAST of the
 * private SQL strippers, and it is the one that guards a SECURITY boundary, so it was migrated
 * only after proving the shared mask is nowhere WEAKER: a 23-case adversarial differential
 * (data-modifying CTEs, `EXPLAIN ANALYZE <mutation>`, keywords hidden behind strings / line and
 * block comments / dollar bodies / quoted identifiers, doubled-`''` escapes, nested block
 * comments, unterminated literals) found zero cases where the shared mask says SAFE while the
 * private scanner said MODIFYING. That corpus is now a COMMITTED test beside this file's other
 * `isDataModifying` cases, and it asserts the SECURITY VERDICT rather than the mask's output —
 * so if the shared module is ever weakened, it fails HERE, at the boundary that matters, and
 * not merely in the stripper's own unit tests.
 *
 * ⚠ The STRINGS variant is required. `stripSqlComments` (comments-only) recurses INTO
 * dollar-quoted bodies and leaves their code live — correct for a lint reading DDL, and exactly
 * wrong here: a `$$ … $$` body is opaque data to this scanner, and leaving it live would flag
 * every function body that merely mentions DELETE.
 */
function stripNoise(sql: string): string {
  return stripSqlCommentsAndStrings(sql);
}

/**
 * True if a statement contains a data-modifying / DDL keyword once strings,
 * comments and dollar-quotes are stripped. Catches data-modifying CTEs and
 * any other mutation smuggled behind an allowed leading keyword.
 */
function isDataModifying(sql: string): boolean {
  return FORBIDDEN_INNER_RE.test(stripNoise(sql));
}

function leadingKeyword(sql: string): string | null {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    while (i < n && /\s/.test(sql[i])) i++;
    if (i + 1 < n && sql[i] === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (i + 1 < n && sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    break;
  }
  if (i >= n) return null;
  const m = sql.slice(i).match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : null;
}

function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      buf += c; i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { buf += "''"; i += 2; continue; }
        buf += sql[i];
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '"') {
      buf += c; i++;
      while (i < n && sql[i] !== '"') { buf += sql[i]; i++; }
      if (i < n) { buf += sql[i]; i++; }
      continue;
    }
    if (c === '$') {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        buf += tag; i += tag.length;
        const close = sql.indexOf(tag, i);
        if (close === -1) { buf += sql.slice(i); i = n; continue; }
        buf += sql.slice(i, close + tag.length);
        i = close + tag.length;
        continue;
      }
    }
    if (c === ';') {
      const trimmed = buf.trim();
      if (trimmed) parts.push(trimmed);
      buf = ''; i++; continue;
    }
    buf += c; i++;
  }
  const last = buf.trim();
  if (last) parts.push(last);
  return parts;
}

class ReadOnlyRollback extends Error {
  constructor() { super('__readonly_rollback'); this.name = 'ReadOnlyRollback'; }
}

/**
 * Test seam — these allowlist primitives are the actual security boundary, so
 * the adversarial suite drives them directly (see dev.test.ts). Not part of
 * the route's public surface; do not import from app code.
 */
export const __test__ = { leadingKeyword, splitStatements, isDataModifying, stripNoise };

export default defineTool({
  method: 'POST',
  path: '/dev/sql',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    let raw: unknown;
    try { raw = await req.json(); }
    catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: 'validation failed', issues: parsed.error.issues }, { status: 400 });
    }
    const { sql: sqlText, role } = parsed.data;

    const stmts = splitStatements(sqlText);
    if (stmts.length === 0) return Response.json({ error: 'empty sql' }, { status: 400 });
    for (const s of stmts) {
      const kw = leadingKeyword(s);
      if (!kw || !ALLOWED_LEADING.has(kw)) {
        return Response.json(
          { error: `rejected: ${kw ?? '?'} statements are not allowed (read-only playground; SELECT/WITH/EXPLAIN/SHOW/TABLE/VALUES only)` },
          { status: 400 },
        );
      }
      // The leading keyword can be an allowed read-only verb while the body
      // still mutates — a data-modifying CTE (`WITH x AS (DELETE …) SELECT …`)
      // being the canonical bypass. Reject any statement whose skeleton (no
      // strings / comments / dollar-quotes) carries a write/DDL keyword.
      if (isDataModifying(s)) {
        return Response.json(
          { error: `rejected: data-modifying statement detected (read-only playground; a data-modifying CTE or write hidden behind ${kw} is not allowed)` },
          { status: 400 },
        );
      }
    }

    const start = Date.now();
    let columns: string[] = [];
    let rows: Record<string, unknown>[] = [];
    let truncated = false;

    try {
      if (role === 'app') {
        const ws = activeWorkspaceId();
        await withWorkspace(ws, async (tx) => {
          await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
          for (let i = 0; i < stmts.length - 1; i++) await tx.unsafe(stmts[i]);
          const last = stmts[stmts.length - 1];
          const result = await tx.unsafe(last);
          const arr = result as unknown as Array<Record<string, unknown>>;
          rows = arr.slice(0, MAX_ROWS_RETURNED);
          if (arr.length > MAX_ROWS_RETURNED) truncated = true;
          columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          throw new ReadOnlyRollback();
        }).catch((e: unknown) => {
          if (e instanceof ReadOnlyRollback) return;
          throw e;
        });
      } else {
        const { sql: pgSql } = getOrgPg();
        await pgSql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
          for (let i = 0; i < stmts.length - 1; i++) await tx.unsafe(stmts[i]);
          const last = stmts[stmts.length - 1];
          const result = await tx.unsafe(last);
          const arr = result as unknown as Array<Record<string, unknown>>;
          rows = arr.slice(0, MAX_ROWS_RETURNED);
          if (arr.length > MAX_ROWS_RETURNED) truncated = true;
          columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          throw new ReadOnlyRollback();
        }).catch((e: unknown) => {
          if (e instanceof ReadOnlyRollback) return;
          throw e;
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const sqlState = (e as { code?: string })?.code;
      return Response.json({ error: msg, sqlState }, { status: 400 });
    }

    const safeRows = rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (v instanceof Date) out[k] = v.toISOString();
        else if (typeof v === 'bigint') out[k] = Number(v);
        else out[k] = v;
      }
      return out;
    });

    return Response.json({
      columns,
      rows: safeRows,
      rowCount: safeRows.length,
      truncated,
      durationMs: Date.now() - start,
      role,
      statements: stmts.length,
    });
  },
});
