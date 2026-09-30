/**
 * pg-mutate-query — run a SINGLE agent-supplied DML statement against the
 * operator Postgres, with the guards a credential-safe write path needs
 * (EI-20478724424443538).
 *
 * WHY: dev:pg_query is deliberately read-only, and the admin credentials are
 * deliberately not exposed to agents — so an AUTHORIZED one-off data repair
 * (fix a stale row, retire a wedged record) previously required
 * process-environment spelunking for a psql password or abusing the
 * schema-migration path. Both defeat the audit design far worse than a scoped
 * write verb does. This is that verb's engine:
 *
 *   - DML ONLY (INSERT / UPDATE / DELETE, optionally under WITH). DDL is
 *     refused: schema stays migrations-only (libs/papercusp/libs/db/sql).
 *   - UPDATE/DELETE require a TOP-LEVEL WHERE — an unbounded clobber must be
 *     spelled `WHERE true` deliberately, and is still row-capped.
 *   - affected-row cap → the transaction ROLLS BACK (nothing committed) when
 *     the statement touches more rows than `maxAffectedRows`.
 *   - `expectedRows` → an exact-match guard; a mismatch rolls back.
 *   - `dryRun` → execute, count, report — then ROLL BACK unconditionally.
 *   - in-transaction audit → the harness_shared.audit_log row COMMITS
 *     ATOMICALLY with the mutation, so a committed write can never exist
 *     without its audit row.
 *
 * The statement guards here are defense-in-depth + early friendly errors; the
 * row-cap/expectedRows rollback inside the transaction is the real enforcement.
 */

import { getOrgPg, getOrgPgLosslessBigint } from '@papercusp/db-org';
import {
  PG_READ_QUERY_DEFAULT_MAX_ROWS,
  PG_READ_QUERY_DEFAULT_TIMEOUT_MS,
  PG_READ_QUERY_HARD_TIMEOUT_MS,
  PG_READ_QUERY_CALL_OVERHEAD_MS,
  SET_LOCAL_UTC,
  callTimeoutMessage,
  personalVaultRefusal,
  stripSqlLiteralsAndComments,
  withCallDeadline,
} from './pg-read-query';

/** The postgres-js client type the org handle exposes. */
type OrgSql = ReturnType<typeof getOrgPg>['sql'];

export const PG_MUTATE_DEFAULT_MAX_AFFECTED = 100;
export const PG_MUTATE_HARD_MAX_AFFECTED = 10_000;

export class PgMutateQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgMutateQueryError';
  }
}

/**
 * A guard tripped AFTER execution — the transaction was rolled back, nothing
 * was committed. Its own class so a caller can tell "your SQL is invalid"
 * (PgMutateQueryError before execution) apart from "your SQL ran, touched an
 * unexpected number of rows, and was undone" — the second one carries the
 * measured count a caller needs to decide whether to re-run with a wider cap.
 */
export class PgMutateGuardError extends PgMutateQueryError {
  readonly rowsAffected: number;
  constructor(message: string, rowsAffected: number) {
    super(message);
    this.name = 'PgMutateGuardError';
    this.rowsAffected = rowsAffected;
  }
}

/** Internal control-flow signal: dryRun executed fine and must roll back. */
class DryRunRollback extends Error {
  constructor(readonly payload: PgMutateQueryResult) {
    super('dry-run rollback');
  }
}

export interface PgMutateQueryResult {
  /** Rows the command reported as affected (INSERT/UPDATE/DELETE count). */
  rowsAffected: number;
  /** RETURNING rows (empty when the statement has no RETURNING), capped. */
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  fields: string[];
  elapsedMs: number;
  /** false = the transaction was rolled back on purpose (dryRun). */
  committed: boolean;
}

export interface PgMutateAudit {
  /** The resolved caller ownerId — never a role name, never 'unknown'. */
  actor: string;
  /** Why this mutation is authorized/needed; stored verbatim in the audit row. */
  reason: string;
  workspaceId: string;
  /** audit_log.action; defaults to 'pg.mutate'. */
  action?: string;
}

const WRITE_VERBS = new Set(['insert', 'update', 'delete']);

interface DepthWord {
  word: string;
  index: number;
}

/** Tokenize depth-0 words of an already-stripped SQL string. */
function depthZeroWords(stripped: string): DepthWord[] {
  const out: DepthWord[] = [];
  let depth = 0;
  let i = 0;
  const len = stripped.length;
  while (i < len) {
    const ch = stripped[i];
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_$]/.test(stripped[j])) j++;
      if (depth === 0) out.push({ word: stripped.slice(i, j).toLowerCase(), index: i });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Validate the query is a single DML statement and return it trimmed. Throws
 * PgMutateQueryError with an actionable message otherwise. The main verb is
 * resolved at paren depth 0, so a CTE body's SELECT never masks the outer
 * write, and `INSERT … ON CONFLICT DO UPDATE` resolves to insert (no WHERE
 * required) while a bare `UPDATE`/`DELETE` must carry a top-level WHERE.
 */
export function assertSingleWriteStatement(raw: string): string {
  const q = raw.trim().replace(/;\s*$/, '').trim();
  if (!q) throw new PgMutateQueryError('empty statement');
  const stripped = stripSqlLiteralsAndComments(q).trim();
  if (stripped.includes(';')) {
    throw new PgMutateQueryError('only a single statement is allowed — remove the `;`-separated statements');
  }
  // Same Personal Vault fence the read surface applies (WI-10001796). Writing
  // the vault ad-hoc is strictly worse than reading it: an UPDATE here forges
  // owner consent rows or rewrites their mail, still with no grant checked and
  // no vault audit trail. Shared with pg-read-query so the two doors cannot
  // drift apart into one being fenced and the other not.
  const vaultRefusal = personalVaultRefusal(q);
  if (vaultRefusal) throw new PgMutateQueryError(vaultRefusal);
  const words = depthZeroWords(stripped);
  if (!words.length) throw new PgMutateQueryError('empty statement');

  const first = words[0].word;
  let verbAt = -1;
  if (WRITE_VERBS.has(first)) {
    verbAt = 0;
  } else if (first === 'with') {
    // The main statement's verb is the first depth-0 verb keyword after the
    // CTE list (CTE bodies sit inside parens, i.e. at depth ≥ 1).
    for (let k = 1; k < words.length; k++) {
      const w = words[k].word;
      if (WRITE_VERBS.has(w)) {
        verbAt = k;
        break;
      }
      if (w === 'select') {
        throw new PgMutateQueryError(
          'the top-level statement is a SELECT — reads go to dev:pg_query; this surface only runs INSERT/UPDATE/DELETE',
        );
      }
    }
    if (verbAt === -1) {
      throw new PgMutateQueryError('could not find a top-level INSERT/UPDATE/DELETE after the WITH clause');
    }
  } else if (first === 'select') {
    throw new PgMutateQueryError(
      'reads go to dev:pg_query — this surface only runs INSERT/UPDATE/DELETE',
    );
  } else {
    throw new PgMutateQueryError(
      `only INSERT / UPDATE / DELETE (optionally under WITH) are allowed — got \`${first.toUpperCase()}\`. ` +
        'Schema changes stay migrations-only (libs/papercusp/libs/db/sql via scripts/next-migration.mjs), never runtime DDL.',
    );
  }

  const verb = words[verbAt].word;
  if (verb === 'update' || verb === 'delete') {
    const hasTopLevelWhere = words.some((w, k) => k > verbAt && w.word === 'where');
    if (!hasTopLevelWhere) {
      throw new PgMutateQueryError(
        `a top-level WHERE is required on ${verb.toUpperCase()} — a whole-table write must be spelled \`WHERE true\` ` +
          'deliberately (and still respects maxAffectedRows)',
      );
    }
  }
  return q;
}

function makeAuditId(): string {
  return `pgm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** First DML target table (for audit_log.subject); best-effort. */
export function primaryWriteTarget(raw: string): string | null {
  const stripped = stripSqlLiteralsAndComments(raw);
  const m = /\b(?:insert\s+into|update|delete\s+from)\s+(?:only\s+)?([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)/i.exec(
    stripped,
  );
  return m ? m[1].toLowerCase() : null;
}

type AuditExec = (query: string, params: unknown[]) => Promise<unknown>;

async function insertAuditRow(
  exec: AuditExec,
  audit: PgMutateAudit,
  subject: string,
  details: Record<string, unknown>,
): Promise<void> {
  await exec(
    'INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id) ' +
      'VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)',
    [makeAuditId(), Date.now(), audit.actor, audit.action ?? 'pg.mutate', subject, JSON.stringify(details), audit.workspaceId],
  );
}

/**
 * Best-effort audit row for a NON-committed outcome (dry run, guard rollback,
 * refused statement, PG error). Never throws — the caller's error/result must
 * reach the agent even when the audit write itself fails.
 */
export async function writePgMutateOutcomeAudit(
  audit: PgMutateAudit,
  outcome: 'dry_run' | 'rolled_back' | 'refused' | 'error',
  sqlText: string,
  extra: Record<string, unknown> = {},
  client?: OrgSql,
): Promise<void> {
  try {
    const sql = client ?? getOrgPg().sql;
    const subject = primaryWriteTarget(sqlText) ?? 'sql';
    await insertAuditRow((q, params) => sql.unsafe(q, params as never[]), audit, subject, {
      sql: sqlText,
      reason: audit.reason,
      outcome,
      ...extra,
    });
  } catch (err) {
    console.warn('[pg-mutate] failed to write outcome audit row:', err);
  }
}

/**
 * Execute a single DML statement inside a guarded transaction. See the module
 * header for the guard set. When `opts.audit` is supplied, the audit row is
 * inserted INSIDE the same transaction so it commits atomically with the
 * mutation; non-commit outcomes are the caller's to record via
 * {@link writePgMutateOutcomeAudit}.
 *
 * Defaults to `getOrgPgLosslessBigint()` for the same reason pgReadQuery does:
 * agent-authored SQL over bigint columns must round-trip exactly.
 */
export async function pgMutateQuery(
  rawQuery: string,
  opts: {
    timeoutMs?: number;
    client?: OrgSql;
    dryRun?: boolean;
    maxAffectedRows?: number;
    expectedRows?: number;
    audit?: PgMutateAudit;
  } = {},
): Promise<PgMutateQueryResult> {
  const query = assertSingleWriteStatement(rawQuery);
  const timeoutMs = Math.max(
    100,
    Math.min(PG_READ_QUERY_HARD_TIMEOUT_MS, Math.trunc(opts.timeoutMs ?? PG_READ_QUERY_DEFAULT_TIMEOUT_MS)),
  );
  const maxAffected = Math.max(
    1,
    Math.min(PG_MUTATE_HARD_MAX_AFFECTED, Math.trunc(opts.maxAffectedRows ?? PG_MUTATE_DEFAULT_MAX_AFFECTED)),
  );
  const expected = opts.expectedRows === undefined ? undefined : Math.max(0, Math.trunc(opts.expectedRows));
  const dryRun = opts.dryRun === true;

  const sql = opts.client ?? getOrgPgLosslessBigint().sql;
  const startedAt = Date.now();
  const callDeadlineMs = timeoutMs + PG_READ_QUERY_CALL_OVERHEAD_MS;

  const work = sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await tx.unsafe(SET_LOCAL_UTC);
    const resultRows = (await tx.unsafe(query)) as unknown as Record<string, unknown>[] & { count?: number };
    const rowsAffected = typeof resultRows.count === 'number' ? resultRows.count : resultRows.length;

    if (rowsAffected > maxAffected) {
      throw new PgMutateGuardError(
        `statement affected ${rowsAffected} rows, over maxAffectedRows=${maxAffected} — ROLLED BACK, nothing was ` +
          'committed. If the count is genuinely intended, re-run with an explicit higher maxAffectedRows ' +
          `(hard cap ${PG_MUTATE_HARD_MAX_AFFECTED}); if it is not, tighten the WHERE.`,
        rowsAffected,
      );
    }
    if (expected !== undefined && rowsAffected !== expected) {
      throw new PgMutateGuardError(
        `statement affected ${rowsAffected} rows but expectedRows=${expected} — ROLLED BACK, nothing was committed. ` +
          'Re-check the predicate (dev:pg_query the same WHERE first), then re-run with the measured count.',
        rowsAffected,
      );
    }

    const maxRows = PG_READ_QUERY_DEFAULT_MAX_ROWS;
    const truncated = resultRows.length > maxRows;
    const capped = truncated ? resultRows.slice(0, maxRows) : [...resultRows];
    const payload: PgMutateQueryResult = {
      rowsAffected,
      rows: capped,
      rowCount: capped.length,
      truncated,
      fields: capped.length ? Object.keys(capped[0]) : [],
      elapsedMs: Date.now() - startedAt,
      committed: !dryRun,
    };

    if (dryRun) throw new DryRunRollback(payload);

    if (opts.audit) {
      await insertAuditRow(
        (q, params) => tx.unsafe(q, params as never[]),
        opts.audit,
        primaryWriteTarget(query) ?? 'sql',
        {
          sql: query,
          reason: opts.audit.reason,
          outcome: 'committed',
          rows_affected: rowsAffected,
          ...(expected !== undefined ? { expected_rows: expected } : {}),
        },
      );
    }
    return payload;
  });

  try {
    return (await withCallDeadline(work, callDeadlineMs, callTimeoutMessage(timeoutMs, callDeadlineMs))) as PgMutateQueryResult;
  } catch (err) {
    if (err instanceof DryRunRollback) {
      // postgres-js rolled the transaction back when the callback threw; the
      // payload rides out on the sentinel.
      return { ...err.payload, elapsedMs: Date.now() - startedAt };
    }
    throw err;
  }
}
