/**
 * Guards the per-harness Postgres schema names the `/harness/all/kpis`
 * aggregate query interpolates directly into `sql.unsafe(...)` (they can't
 * be bound params — they're identifiers, one per harness schema, unioned
 * into a single dynamic query). Schema names derive from the installed-
 * harness registry's `slug` (sanitized to `harness_<slug-with-underscores>`
 * upstream), but this is the last line of defense before the string hits
 * `sql.unsafe`: only names matching a plain identifier shape pass, so a
 * malformed/foreign schema name can never smuggle SQL via string
 * interpolation.
 */
const SAFE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSafeSchemaName(name: string): boolean {
  return SAFE_IDENTIFIER_RE.test(name);
}

export function filterSafeSchemaNames(names: Iterable<string>): string[] {
  return [...names].filter(isSafeSchemaName);
}
