/**
 * Async compatibility shim mimicking the better-sqlite3 `.prepare(sql).get/all/run/iterate`
 * API on top of postgres-js. Lets call sites move from sync sqlite to async pg
 * with minimal per-line churn — the only required change is `await`-ing the
 * `.get/.all/.run` calls.
 *
 * Translates SQLite-style `?` positional placeholders to Postgres `$1, $2, …`.
 * Also accepts named parameter bindings via the SQLite `@name` syntax — these
 * are converted to `$N` and reordered against an object argument, matching
 * better-sqlite3's behavior.
 *
 * Usage:
 *   const c = getLegacyClient();              // admin role, search_path=harness_shared,public
 *   const c = getLegacyClient('org');         // search_path=harness_org, harness_shared, public
 *   const row = await c.prepare('SELECT * FROM projects WHERE id = ?').get(id);
 *   const rows = await c.prepare('SELECT * FROM harness_features WHERE harness_slug = ?').all(slug);
 *   await c.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, name);
 *   await c.transaction(async (tx) => { ... });
 *
 * NOT supported:
 *   - .iterate() (we don't use it)
 *   - returning lastInsertRowid from .run() (we don't use it; identity columns
 *     auto-generate)
 *   - SQLite-only functions (datetime(), strftime(), etc.)
 */
import type { Sql, TransactionSql } from 'postgres';
import { getOrgPg, getHarnessPg, pgbouncerEnabled } from './connection';
import { withHarnessSchema } from './workspace-context';

function translatePlaceholders(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
  // Named-param case: a single object with @-prefixed keys.
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const obj = args[0] as Record<string, unknown>;
    const ordered: unknown[] = [];
    let n = 0;
    const out = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, key: string) => {
      if (!(key in obj)) throw new Error(`legacy-shim: missing named param @${key}`);
      ordered.push(obj[key]);
      n += 1;
      return `$${n}`;
    });
    if (n > 0) return { sql: out, args: ordered };
    // Fall through — object value is being treated as a positional arg.
  }
  // Positional `?` case.
  let i = 0;
  const out = sql.replace(/\?/g, () => {
    i += 1;
    return `$${i}`;
  });
  if (i !== args.length && i > 0) {
    throw new Error(`legacy-shim: placeholder/argument mismatch (${i} placeholders, ${args.length} args) in: ${sql}`);
  }
  return { sql: out, args };
}

export interface LegacyPrepared {
  get<T = any>(...args: any[]): Promise<T | undefined>;
  all<T = any>(...args: any[]): Promise<T[]>;
  run(...args: any[]): Promise<void>;
}

export interface LegacyClient {
  prepare(sql: string): LegacyPrepared;
  /**
   * Run `fn` inside a Postgres transaction. Awaits the resulting Promise
   * directly — call as `await c.transaction(async (tx) => { ... })`.
   *
   * (Pre-2026-05-01 this returned `() => Promise<T>` and required a trailing
   * `()` invocation, which all 13 call sites omitted — silently bypassing
   * the transaction. The signature now matches the actual call-site usage.)
   */
  transaction<T>(fn: (tx: LegacyClient) => Promise<T>): Promise<T>;
}

function makeClient(sqlTag: Sql | TransactionSql): LegacyClient {
  return {
    prepare(query: string): LegacyPrepared {
      return {
        async get<T = any>(...args: any[]): Promise<T | undefined> {
          const { sql: t, args: a } = translatePlaceholders(query, args);
          const rows = await sqlTag.unsafe<T[]>(t, a as any[]);
          return rows[0];
        },
        async all<T = any>(...args: any[]): Promise<T[]> {
          const { sql: t, args: a } = translatePlaceholders(query, args);
          return await sqlTag.unsafe<T[]>(t, a as any[]);
        },
        async run(...args: any[]): Promise<void> {
          const { sql: t, args: a } = translatePlaceholders(query, args);
          await sqlTag.unsafe(t, a as any[]);
        },
      };
    },
    transaction<T>(fn: (tx: LegacyClient) => Promise<T>): Promise<T> {
      return (sqlTag as Sql).begin(async (txTag) => {
        return await fn(makeClient(txTag));
      }) as Promise<T>;
    },
  };
}

/**
 * Returns a sync-style legacy client. Pass a slug to scope `search_path` to
 * that harness's schema; omit for cross-harness admin queries.
 */
export function getLegacyClient(slug?: string): LegacyClient {
  const handle = slug ? getHarnessPg(slug) : getOrgPg();
  return makeClient(handle.sql);
}

/**
 * Run `fn` against a legacy client whose connection has `app.workspace_id`
 * set. The callback receives a `LegacyClient` bound to a transaction; all
 * `.prepare(...).all/get/run` calls inside the callback see the GUC and
 * therefore RLS predicates pass for the active workspace.
 *
 * Use this when retrofitting older `getLegacyClient(slug).prepare(...)` code
 * paths that need workspace-aware harness_shared.* reads after 010-RLS lands.
 *
 * PgBouncer routing (WI-4995 part (a)): when `slug` is given AND
 * pgbouncerEnabled(), this runs through `withHarnessSchema` — the SAME
 * per-transaction-`search_path` chokepoint `harnessQuery` uses under the
 * pooler — instead of a direct `getHarnessPg(slug)` connection, and sets
 * `app.workspace_id` inside that SAME transaction. Direct-connection mode
 * (pgbouncer disabled) is byte-identical to before: `getHarnessPg(slug)`'s
 * pool already carries the harness search_path at connect time.
 *
 * `slug === undefined` (cross-harness admin) has no harnessQuery/withHarnessSchema
 * equivalent — that path stays on the direct `getOrgPg()` admin connection; see
 * WI-4995(c).
 */
export async function withWorkspaceLegacy<T>(
  slug: string | undefined,
  workspaceId: string,
  fn: (db: LegacyClient) => Promise<T>,
): Promise<T> {
  if (slug && pgbouncerEnabled()) {
    return withHarnessSchema(slug, async (txTag) => {
      await txTag`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return await fn(makeClient(txTag));
    });
  }
  const handle = slug ? getHarnessPg(slug) : getOrgPg();
  return (handle.sql as Sql).begin(async (txTag) => {
    await txTag`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return await fn(makeClient(txTag));
  }) as Promise<T>;
}
