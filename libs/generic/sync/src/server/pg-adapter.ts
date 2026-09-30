/**
 * Postgres LISTEN/NOTIFY adapters for the invalidation bus.
 *
 * Thin glue that turns a postgres-js-style client into the bus's
 * `ListenSource` / `NotifySink` seams. Dependency-free: the host passes
 * in its own postgres client(s) (structurally `PgSqlLike`), so this lib
 * never imports `postgres` and never opens its own connection policy.
 *
 * Typical host wiring (operator):
 *
 *   import postgres from 'postgres';
 *   import { getOrgPg } from '@papercusp/db-org';
 *   const listen = createPgListenSource({
 *     open: () => postgres(adminUrl, { max: 1, idle_timeout: 0 }),
 *     channel: 'sync_invalidate',
 *   });
 *   const notify = createPgNotifySink({
 *     getSql: () => getOrgPg().sql,           // reuse the shared pool
 *     channel: 'sync_invalidate',
 *   });
 */

import type { ListenSource, NotifySink } from './invalidation-bus';

/**
 * Minimal structural shape of a postgres-js client — only what the
 * adapters use. A real `postgres()` Sql satisfies this.
 */
export interface PgSqlLike {
  /** Tagged-template query, e.g. sql`SELECT pg_notify(${ch}, ${payload})`.
   *  Loosely typed (any) so a real postgres-js `Sql` — with its many call
   *  overloads + PendingQuery return — structurally satisfies it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (strings: TemplateStringsArray, ...args: any[]): any;
  /** Subscribe to a NOTIFY channel; resolves once the LISTEN is ready.
   *  `onListen` is accepted (postgres passes it) but unused here. */
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListen?: () => void,
  ): Promise<unknown>;
  /** Close the connection (optional in the structural type). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  end?(...args: any[]): Promise<void>;
}

const DEFAULT_CHANNEL = 'sync_invalidate';

/**
 * A `ListenSource` backed by a dedicated postgres `LISTEN` connection.
 * `open()` is called once on `start()` to create the (long-lived,
 * single-connection) client — the host decides the pool policy.
 *
 * `onListen` is invoked every time the LISTEN is (re)established — on the
 * initial subscribe AND after the dedicated connection drops and postgres-js
 * transparently reconnects + re-issues the `LISTEN` (its `onclose` → re-`listen`
 * path re-invokes the listener's `onlisten`). This is the COLD-BUST hook: a
 * fire-and-forget NOTIFY that fired while the connection was down is never
 * replayed to this LISTEN, so any host-side cache fed by the stream could hold
 * stale entries across the gap; `onListen` lets the host clear that cache on
 * every (re)connect. (It fires on the first connect too — clearing a still-empty
 * cache is a harmless no-op.)
 */
export function createPgListenSource(opts: {
  open: () => PgSqlLike;
  channel?: string;
  onListen?: () => void;
}): ListenSource {
  const channel = opts.channel ?? DEFAULT_CHANNEL;
  let sql: PgSqlLike | null = null;
  return {
    async start(onMessage) {
      sql = opts.open();
      await sql.listen(
        channel,
        (raw) => onMessage(raw),
        opts.onListen ? () => opts.onListen?.() : undefined,
      );
    },
    async stop() {
      if (sql?.end) await sql.end({ timeout: 5 });
      sql = null;
    },
  };
}

/**
 * A `NotifySink` that fires `pg_notify(channel, payload)` on the host's
 * (shared) pool. `getSql` is read per-call so it always uses the live
 * pool — opening a fresh connection per notify would exhaust the budget.
 */
export function createPgNotifySink(opts: {
  getSql: () => PgSqlLike;
  channel?: string;
}): NotifySink {
  const channel = opts.channel ?? DEFAULT_CHANNEL;
  return {
    async notify(payloadJson) {
      const sql = opts.getSql();
      await sql`SELECT pg_notify(${channel}, ${payloadJson})`;
    },
  };
}
