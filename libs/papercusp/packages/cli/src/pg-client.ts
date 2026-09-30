/**
 * Tiny postgres-js wrapper used by the CLI in place of `spawnSync('psql', …)`.
 *
 * Why: a postgres-client binary isn't guaranteed on the desktop bundle (we ship
 * embedded-postgres-server's server binaries + node, but client tools like `psql`
 * are sourced separately). Spawning `psql` worked on dev machines and silently
 * failed elsewhere — most visibly during plugin install when applying a plugin's
 * `schema.sql`. Going through postgres-js means the CLI can talk to Postgres
 * directly, no external program required, on any platform.
 *
 * Behavior differences vs `psql -f`:
 *   - The whole SQL script is sent as a single multi-statement command. Errors
 *     mid-script roll back everything (psql with ON_ERROR_STOP also halts but
 *     leaves earlier statements committed if they were in their own implicit
 *     transactions). For DDL this is generally what you want.
 *   - psql meta-commands (`\set`, `\i`, `\copy`, etc.) are not supported and
 *     will fail at parse time. None of the in-tree DDLs use them.
 */

import { promises as fs } from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import postgres from 'postgres';

export interface PgConnOpts {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

/**
 * Build a libpq-style URL from explicit fields, falling back to `PG*` env vars
 * the same way psql does. Caller decides which env defaults to use (cmdDoctor
 * and plugin install historically diverged on user/password defaults).
 */
export function buildPgUrl(opts: PgConnOpts = {}): string {
  const host = opts.host ?? process.env.PGHOST ?? 'localhost';
  const port = opts.port ?? Number(process.env.PGPORT ?? 5432);
  const user = opts.user ?? process.env.PGUSER ?? 'postgres';
  const password = opts.password ?? process.env.PGPASSWORD ?? '';
  const database = opts.database ?? process.env.PGDATABASE ?? 'postgres';
  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user);
  return `postgresql://${auth}@${host}:${port}/${encodeURIComponent(database)}`;
}

/**
 * Run a single SELECT and return its rows. Always closes the connection.
 * Returns null if the connection itself failed (mirrors the psql exit-status
 * check pattern the call sites used).
 */
export async function runQuery<T = Record<string, unknown>>(
  url: string,
  sqlText: string,
  timeoutMs = 3000,
): Promise<T[] | null> {
  // Lazy-pool: one connection, short idle, no prepared-statement caching since
  // we issue one ad-hoc query and exit. `connect_timeout` is in seconds.
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 1,
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    prepare: false,
    onnotice: () => { /* silence NOTICE chatter */ },
  });
  try {
    // postgres-js's `.unsafe` accepts a raw SQL string and returns rows.
    // We race it against a manual timer because the lib's `connect_timeout`
    // only covers the initial handshake, not statement execution.
    const result = await Promise.race([
      sql.unsafe(sqlText),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`query timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return result as unknown as T[];
  } catch {
    return null;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => { /* best-effort close */ });
  }
}

export interface ApplyResult {
  ok: boolean;
  /** Empty when ok; one-line error otherwise (truncated to 200 chars). */
  error: string;
}

/**
 * Read a .sql file from disk and execute its full contents as one statement
 * batch against `url`. Multi-statement; rolls back the whole batch on failure.
 * Replaces `psql -v ON_ERROR_STOP=1 -f file.sql` for plugin schema apply.
 */
export async function applySqlFile(url: string, ddlPath: string, timeoutMs = 30_000): Promise<ApplyResult> {
  let sqlText: string;
  try {
    sqlText = await fs.readFile(ddlPath, 'utf8');
  } catch (err) {
    return { ok: false, error: `read ${ddlPath}: ${(err as Error).message}`.slice(0, 200) };
  }
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 1,
    connect_timeout: 5,
    prepare: false,
    onnotice: () => {},
  });
  try {
    await Promise.race([
      sql.unsafe(sqlText),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`apply timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return { ok: true, error: '' };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    return { ok: false, error: msg.replace(/\s+/g, ' ').slice(0, 200) };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}
