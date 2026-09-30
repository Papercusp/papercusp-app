/**
 * ISO-8601 rendering for a timestamp column read through a raw `sql\`...\`` tagged
 * template on a canonical client.
 *
 * ## Why this is not just `d.toISOString()`
 *
 * A `timestamp with time zone` (OID 1184) column arrives as a **string**, not a `Date`.
 * Measured 2026-08-13 against `harness_shared.test_runs.started_at` on the canonical org
 * client: `typeof === 'string'`, `constructor.name === 'String'`, `toISOString ===
 * undefined`. Only OID 1114 (`timestamp` WITHOUT time zone) carries a parser that yields
 * a `Date` — `PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES`, merged unconditionally by `buildClient`.
 * 1184 has no such override, and the driver's default parser for it does not survive on
 * the shared client (the same drizzle-mutates-the-client class documented on
 * `restoreRawDateSerializers`, EI-13076).
 *
 * The trap is that TypeScript cannot catch this: these row shapes are hand-declared on
 * the `sql<Array<{ started_at: Date }>>` call, so the annotation is an ASSERTION about
 * the driver, not a check of it. It typechecks clean and throws `d.toISOString is not a
 * function` on the first row — which is exactly how `testing:runs` and `db:migrations`
 * were both dead on EVERY call while their types looked right.
 *
 * So this coercion is total over what the driver actually returns, rather than over what
 * the row type claims it returns. An unparseable or absent value yields `null`, never a
 * thrown formatter and never the string "Invalid Date".
 */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  // Epoch milliseconds — the shape a bigint `*_ts` column takes once the canonical
  // bigint→Number parser has run.
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }
  return null;
}
