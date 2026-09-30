/**
 * Strip MIGRATION-INTERNAL scratch tables from a drizzle-kit-introspected schema.
 * EI-18785808338338490.
 *
 * Migrations copy rows aside into quarantine or backup tables — e.g. migration
 * 686 does `CREATE TABLE harness_shared._pot_members_686_orphans (LIKE
 * pot_members INCLUDING DEFAULTS)` to preserve rows an FK repoint would
 * otherwise strand. Migration-internal tables use either a leading underscore
 * or a `bak_` prefix. Neither convention is application surface, but
 * drizzle-kit introspects every table it can see, so both otherwise land in the
 * application's ORM schema as first-class exports.
 *
 * That is noise at best, and it has already cost real time: drizzle-kit emitted
 * `text("revoked_pubkeys")` WITHOUT `.array()` for the 686 orphan clone while
 * emitting it correctly for `pot_members` itself. The two columns are identical
 * in the catalog (both `_text`, both DEFAULT '{}'::text[], both NOT NULL), so
 * the table name is the only variable. The mis-shaped column then reds
 * `lint:tsc` with a TS2345 in a package that never touched the schema — and
 * because the orphan table is a LIKE-clone, its columns read EXACTLY like
 * `pot_members`, so the error invites being diagnosed against the wrong table.
 *
 * Stripping fixes the whole class rather than the one column: no scratch table
 * can contribute a declaration, so none can be mis-shaped.
 *
 * A paren-balanced walk is required — a table block contains nested objects,
 * arrays, and template literals (sql`…` policy predicates), so no regex can
 * reliably find its end. Quote/backtick spans are skipped so a `)` inside a
 * string never closes the walk. If a block is unbalanced we leave it ALONE
 * rather than risk corrupting the generated file.
 *
 * @param {string} schema drizzle-kit's generated schema source
 * @returns {{ schema: string, stripped: string[] }} the source with scratch
 *   table statements removed, and the table names removed (in file order)
 */
export function stripScratchTableDeclarations(schema) {
  const declRe = /export const \w+ = (?:pgTable|\w+\.table)\(\s*"((?:_|bak_)[^"]*)"\s*,/g;
  const removals = [];
  let m;
  while ((m = declRe.exec(schema)) !== null) {
    const open = schema.indexOf('(', m.index);
    let depth = 0;
    let i = open;
    let quote = null;
    for (; i < schema.length; i++) {
      const ch = schema[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
    }
    // Unbalanced (ran off the end): skip it rather than corrupt the file.
    if (depth !== 0) continue;
    let end = i + 1;
    if (schema[end] === ';') end++;
    if (schema[end] === '\n') end++;
    removals.push({ start: m.index, end, name: m[1] });
  }
  const stripped = removals.map((r) => r.name);
  // Splice back-to-front so earlier offsets stay valid.
  for (const r of [...removals].reverse()) {
    schema = schema.slice(0, r.start) + schema.slice(r.end);
  }
  return { schema, stripped };
}
