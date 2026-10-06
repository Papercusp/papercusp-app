/**
 * Timestamp columns read with raw `sql` on the canonical Postgres pools (WI-10004446).
 *
 * drizzle-orm's postgres-js driver replaces the shared client's date/time PARSERS with a
 * pass-through the first time anything wraps that client (`drizzle-orm/postgres-js/driver.js`,
 * `construct()`); `restoreRawDateSerializers` in libs/db `raw-serializers.ts` restores only the
 * SERIALIZERS. So a `timestamptz` column read by a raw query arrives as a `Date` before any drizzle
 * wrap and as Postgres' text form after it, depending on what the process has already run. The
 * hosted control plane's pool returned text, and portal MCP OAuth registration then threw on
 * `createdAt.getTime()`.
 *
 * Every connected-apps store therefore types a raw timestamp column as `PgTimestamp` and turns it
 * into a `Date` here, at the read boundary, so nothing downstream ever sees a string. A value that
 * does not parse throws, naming the column, instead of travelling on as an Invalid Date.
 */

/** What a raw `timestamptz` read can hand back, depending on the pool's parser state. */
export type PgTimestamp = Date | string;

/** The column's value as a valid `Date`; throws when it is not a timestamp. */
export function pgDate(value: PgTimestamp, column: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${column} is not a timestamp: ${String(value)}`);
  return date;
}

/** `pgDate` for a nullable column: SQL NULL stays `null`. */
export function pgDateOrNull(value: PgTimestamp | null | undefined, column: string): Date | null {
  return value === null || value === undefined ? null : pgDate(value, column);
}
