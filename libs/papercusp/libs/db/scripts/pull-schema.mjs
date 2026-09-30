#!/usr/bin/env node
/**
 * Regenerate src/schema/generated.ts + generated-relations.ts from the
 * live `papercusp` database. Run after any new `.sql` migration in ./sql/.
 *
 * Usage: node libs/papercusp/libs/db/scripts/pull-schema.mjs
 *
 * After running:
 *   1. Inspect the diff in src/schema/generated.ts
 *   2. If the diff is intentional, commit it. If not, investigate the
 *      `.sql` migration that caused it.
 *
 * CI runs this and fails if the diff is non-empty (proves source-of-truth
 * is `.sql`, schema/generated.ts is a mirror).
 *
 * Drizzle-kit v0.31.10 quirks the script silently patches so the
 * regenerated output is committable as-is (see PHASE0-AUDIT.md):
 *   Fix 0: drop MIGRATION-INTERNAL scratch tables (leading underscore, e.g.
 *          `_pot_members_686_orphans`) — drizzle-kit introspects every table
 *          it can see, including migration quarantine tables that are not
 *          application surface. EI-18785808338338490; logic + rationale in
 *          ../src/schema-scratch-tables.mjs (unit-tested).
 *   Fix 1: empty-string defaults emit `.default(')` (invalid TS), and empty
 *          PostgreSQL array defaults emit `.array().default([""])` (the
 *          wrong one-element array).
 *   Fix 2: drop invalid `mode: 'number'` on timestamptz → drizzle default 'date'.
 *   Fix 3: function-call defaults wrapped in sql`` (e.g. to_char(now(), …)).
 *   Fix 4: `unknown(...)` for tsvector/bytea mapped to real customType
 *          columns (bytea → Buffer, tsvector → string; audit P-075) —
 *          unmapped unknown types still fall back to text() with the TODO
 *          comment retained.
 *   Fix 5: missing PKs (drizzle-kit drops ~half of them) injected via PG.
 *   Fix 6: relations.ts import rewritten from "./schema" to "./generated".
 *   Fix 7: drizzle-kit truncates `((EXTRACT(epoch FROM now()) * (1000)::numeric))::bigint`
 *          at the type-cast colon, producing unbalanced-paren SQL that
 *          breaks esbuild. Rewrite to a balanced `(EXTRACT(epoch FROM
 *          now()) * 1000)::bigint`.
 *   Fix 8: mutually-referencing composite foreign keys make TypeScript infer
 *          both generated table declarations through each other (TS7022 /
 *          TS7024). Annotate only cycle participants' extra-config callbacks.
 *   Fix 9: after promotion, remove drizzle-kit's ignored schema.ts /
 *          relations.ts intermediates so package typecheck cannot compile a
 *          stale second schema mirror.
 *   Fix 10: drizzle-kit can attach ordered index operator classes to the wrong
 *           fields in multi-column indexes; restore the live PG catalog order.
 *   Fix 11: drizzle-kit retains PostgreSQL's trailing `NOT VALID` clause in
 *           check() SQL and leaves unmatched closing parentheses; remove the
 *           unsupported clause and repair only the unmatched suffix.
 *   Fix 13: drizzle-kit can attach a table's policy predicates to only one
 *           pgPolicy entry when policy introspection order changes; restore
 *           each USING / WITH CHECK expression from pg_policies by identity.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { stripScratchTableDeclarations } from '../src/schema-scratch-tables.mjs';
import { repairEmptyArrayDefaults } from '../src/schema/schema-defaults.mjs';
import {
  annotateCircularForeignKeyExtraConfigs,
  promoteGeneratedSchemaArtifacts,
  repairCompositeForeignKeyArtifacts,
} from '../src/schema-generated-artifacts.mjs';
import { repairIndexOperatorClasses } from '../src/schema/schema-index-opclasses.mjs';
import {
  sortTopLevelDeclarations,
  sortPgCoreImportSpecifiers,
} from '../src/schema/schema-declaration-order.mjs';
import { repairNotValidChecks } from '../src/schema/schema-checks.mjs';
import { repairPgPolicyPredicates } from '../src/schema/schema-policies.mjs';
import { resolveAdminUrlWithSource, redactAdminUrl } from '../src/resolve-cli-admin-url.mjs';
import {
  createSchemaCliSpawnOptions,
  normalizeSchemaCliOutput,
} from '../src/schema-cli-output.mjs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = resolve(__dirname, '..');
const SCHEMA_DIR = join(DB_ROOT, 'src/schema');

// MAIN-GUARD (EI-18786840446203185). Everything below runs at module scope, so
// a bare `import()` of this file — the ordinary way to check that a module
// loads — CONNECTS TO THE LIVE DB, introspects every table, and overwrites
// src/schema/*.ts in the shared working tree. That is a fleet-wide blast radius
// (regenerating pulls in every peer's accumulated schema drift at once), reached
// by an action that looks read-only. It has happened.
//
// Refuse to execute unless we are the process entrypoint. Throwing — rather than
// exiting — leaves the importer alive with a clear message, so inspection still
// works. Wrapping the whole script in a main() would be the tidier shape; this
// guard is the zero-risk version of the same protection.
// NOTE the absent-argv case must FAIL CLOSED: under `node -e "import(...)"` —
// the exact accident this guards — process.argv[1] is UNDEFINED, so a
// `process.argv[1] && ...` condition short-circuits and the guard never fires.
// (First version of this guard had that bug; it ran the live pull anyway.)
const __entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url !== __entry) {
  throw new Error(
    'pull-schema.mjs is a CLI script with side effects (live DB introspection + rewrites ' +
      'src/schema/*.ts in the shared tree) and was IMPORTED rather than run. Refusing to ' +
      'execute. Run it as `node libs/papercusp/libs/db/scripts/pull-schema.mjs`; to check ' +
      'that it merely parses, use `node --check <file>`.',
  );
}

console.log('==> running drizzle-kit pull against live papercusp DB');

// Resolve the admin URL ONCE and reuse it for both the precheck below and the
// Fix 5 composite-PK psql query further down — so they can never diverge
// (they used to: this `dbUrl` used to be a separate, narrower env-only
// resolution with no discovery-file support at all, so on a desktop-embedded-
// PG box it could silently query a DIFFERENT Postgres than the one
// drizzle-kit had just introspected).
const { url: dbUrl, source: dbUrlSource } = resolveAdminUrlWithSource();

// PRECHECK connectivity before invoking drizzle-kit (EI-19949168182332635).
// A dead/unreachable target — most commonly a STALE discovery-file entry
// from a desktop embedded-PG that has since exited — makes drizzle-kit fail
// with a content-free "0 tables fetching ... drizzle-kit pull failed", which
// reads exactly like a real DB outage or an empty schema. Fail loud and
// specific here instead, when we can: this needs `psql` on PATH, and if it's
// missing we skip the precheck and fall through to drizzle-kit unchanged
// (same behavior as before this fix) rather than blocking the script on a
// tool it doesn't otherwise require.
{
  const precheck = spawnSync('psql', [dbUrl, '-tAc', 'SELECT 1'], { encoding: 'utf8' });
  if (precheck.error == null && precheck.status !== 0) {
    console.error(
      '\n✗ Cannot reach Postgres at the resolved admin URL ' +
        `(source: ${dbUrlSource}):\n    ${redactAdminUrl(dbUrl)}\n` +
        (precheck.stderr?.trim() ? `  psql said: ${precheck.stderr.trim()}\n` : '') +
        '\n  This is why drizzle-kit would otherwise fail with a content-free ' +
        '"0 tables fetching ... drizzle-kit pull failed" — the target above is ' +
        'UNREACHABLE, not an empty database.\n' +
        '  Fix: set HARNESS_ADMIN_DATABASE_URL (or DATABASE_URL) to a reachable ' +
        'connection string, or start the desktop app / native PG this resolved from.\n',
    );
    process.exit(1);
  }
}

// Prefer the locally-installed drizzle-kit. `npx -y drizzle-kit@^0.31.10`
// refetches a fresh, isolated copy into the npx cache, which then can't
// resolve `drizzle-orm` under pnpm's symlinked node_modules layout
// ("Error please install required packages: 'drizzle-orm'"). The local
// install (same pinned version, same workspace tree) resolves it fine.
// Fall back to npx only when drizzle-kit isn't installed locally.
const localRequire = createRequire(import.meta.url);
function resolveLocalDrizzleKitBin() {
  try {
    let d = dirname(localRequire.resolve('drizzle-kit'));
    for (let i = 0; i < 5; i++) {
      const bin = join(d, 'bin.cjs');
      if (existsSync(bin)) return bin;
      d = dirname(d);
    }
  } catch { /* not installed locally — fall back to npx */ }
  return null;
}
const localKitBin = resolveLocalDrizzleKitBin();
const introspectArgs = ['introspect', '--config=' + join(DB_ROOT, 'drizzle.config.ts')];
const captureDrizzleKitOutput = !process.stdout.isTTY;
const drizzleKitSpawnOptions = createSchemaCliSpawnOptions({
  cwd: DB_ROOT,
  env: { ...process.env },
  interactive: !captureDrizzleKitOutput,
});
const result = localKitBin
  ? spawnSync(process.execPath, [localKitBin, ...introspectArgs], drizzleKitSpawnOptions)
  : spawnSync(
      'npx',
      ['-y', 'drizzle-kit@^0.31.10', ...introspectArgs],
      drizzleKitSpawnOptions,
    );
if (captureDrizzleKitOutput && result.stdout) {
  const normalizedOutput = normalizeSchemaCliOutput(result.stdout);
  if (normalizedOutput) process.stdout.write(normalizedOutput);
}
if (result.status !== 0) {
  console.error('drizzle-kit pull failed');
  process.exit(result.status ?? 1);
}

const schemaPath = join(SCHEMA_DIR, 'schema.ts');
const relationsPath = join(SCHEMA_DIR, 'relations.ts');
if (!existsSync(schemaPath)) {
  console.error('expected drizzle-kit to write src/schema/schema.ts');
  process.exit(1);
}

console.log('==> applying quirk fixups');
let schema = readFileSync(schemaPath, 'utf8');

// Fix 11: PostgreSQL appends `NOT VALID` to an unvalidated check definition,
// but drizzle-kit assumes the expression is the end of the definition. Its
// output can therefore retain the clause and add unmatched closing parens.
// Drizzle's check() builder cannot represent validity, so normalize this in
// the generated mirror. The pure helper is unit-tested without a live DB.
const repairedNotValidChecks = repairNotValidChecks(schema);
schema = repairedNotValidChecks.source;
if (repairedNotValidChecks.fixed > 0) {
  console.log(`    Fix 11: repaired ${repairedNotValidChecks.fixed} NOT VALID check(s)`);
}

// Fix 0: drop MIGRATION-INTERNAL scratch/backup tables (leading underscore or
// `bak_`) before any other fixup sees them. EI-18785808338338490. Logic +
// rationale live in ../src/schema-scratch-tables.mjs so they are unit-tested
// rather than buried in a script (schema-scratch-tables.test.ts).
const { stripped: strippedScratchTables } = (() => {
  const r = stripScratchTableDeclarations(schema);
  schema = r.schema;
  return r;
})();
if (strippedScratchTables.length > 0) {
  console.log(
    `    Fix 0: stripped ${strippedScratchTables.length} migration-internal table(s): ${strippedScratchTables.join(', ')}`,
  );
}

// Fix 13: pg_policies is the authoritative source for policy predicates.
// drizzle-kit can preserve policy names, roles, and commands while dropping
// or moving USING / WITH CHECK expressions between sibling policies on the
// same table. Match by schema + table + policy name, never by the order
// drizzle-kit happened to emit its entries.
const policyQuery = [
  "SELECT COALESCE(json_agg(row_to_json(q) ORDER BY q.schemaname, q.tablename, q.policyname), '[]'::json)",
  'FROM (',
  '  SELECT schemaname, tablename, policyname, qual, with_check',
  '  FROM pg_policies',
  "  WHERE schemaname IN ('harness_shared','papercusp_shared')",
  ') q;',
].join(' ');
const policyResult = spawnSync('psql', [dbUrl, '-tA', '-c', policyQuery], { encoding: 'utf8' });
if (policyResult.status !== 0) {
  console.error('failed to read authoritative pg_policy metadata:', policyResult.stderr);
  process.exit(1);
}
let policyRows;
try {
  policyRows = JSON.parse(policyResult.stdout.trim() || '[]');
} catch (error) {
  console.error(
    'authoritative pg_policy metadata was not valid JSON:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
}
const policyFix = repairPgPolicyPredicates({ source: schema, policies: policyRows });
if (policyFix.unresolved.length > 0) {
  console.error(
    'refusing to promote generated schema with unresolved pgPolicy predicates:\n  - ' +
      policyFix.unresolved.join('\n  - '),
  );
  process.exit(1);
}
schema = policyFix.source;
console.log(`    Fix 13: repaired ${policyFix.repaired} pgPolicy declaration(s) from pg_policies`);

// Fix 1: empty-string default rendering bug.
schema = schema
  .replace(/\.default\('\)\./g, ".default('').")
  .replace(/\.default\('\)\,/g, ".default(''),")
  .replace(/\.default\('\)$/gm, ".default('')");
const fixedDefaults = (schema.match(/\.default\(''\)/g) ?? []).length;

// Fix 1b: drizzle-kit renders PostgreSQL's empty array default (`'{}'`) as
// `array().default([""])`, changing an empty array into one empty-string
// element. Repair the generator output before promoting it to the committed
// application schema. The pure helper is unit-tested without a live DB.
const repairedArrayDefaults = repairEmptyArrayDefaults(schema);
schema = repairedArrayDefaults.schema;
const fixedEmptyArrayDefaults = repairedArrayDefaults.fixed;

// Fix 2: drop the `mode` on timestamptz columns → drizzle's default 'date'
// (returns a JS Date). drizzle-orm 0.45 only accepts mode 'date'|'string' on
// timestamp — the old `mode: 'number'` rewrite (a Zero-era hack) produces code
// that no longer typechecks, and at runtime 0.45 ignores the bad mode and
// returns a Date anyway, so this is behavior-preserving + honest. (Zero is on
// the retirement path; epoch-ms columns are already `bigint({mode:'number'})`.)
schema = schema.replace(
  /timestamp\(\{ withTimezone: true, mode: 'string' \}\)/g,
  "timestamp({ withTimezone: true })",
);
const fixedTimestamps = (
  schema.match(/timestamp\(\{ withTimezone: true \}\)/g) ?? []
).length;

// Fix 3: function-call defaults emit as raw JS with broken escapes
// (e.g. `default(to_char(now(), \'YYYY-MM\'::text))`). Per-default fix:
// balanced-paren walk from `.default(`, treating backticks as "skip
// region" so existing `sql`(...)`` content isn't miscounted. Wrap any
// inner content containing `\'` in a sql`` template.
let fixedFnDefaults = 0;
{
  const out = [];
  let i = 0;
  while (i < schema.length) {
    const idx = schema.indexOf('.default(', i);
    if (idx === -1) {
      out.push(schema.slice(i));
      break;
    }
    out.push(schema.slice(i, idx));
    let depth = 1;
    let j = idx + '.default('.length;
    while (j < schema.length && depth > 0) {
      const ch = schema[j];
      if (ch === '`') {
        // Skip backtick-quoted region (e.g. existing sql`...`)
        const close = schema.indexOf('`', j + 1);
        if (close === -1) { j = schema.length; break; }
        j = close + 1;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      j++;
    }
    const innerStart = idx + '.default('.length;
    const inner = schema.slice(innerStart, j - 1); // excludes closing `)`
    if (inner.includes("\\'") && !inner.trimStart().startsWith('sql`')) {
      const unescaped = inner.replace(/\\'/g, "'");
      out.push('.default(sql`' + unescaped + '`)');
      fixedFnDefaults++;
    } else {
      out.push('.default(' + inner + ')');
    }
    i = j;
  }
  schema = out.join('');
}

// Fix 4: drizzle-kit emits `unknown(...)` + a `// TODO: failed to parse
// database type 'X'` comment for PG types it can't introspect. Map bytea →
// Buffer and tsvector → string via customType (audit P-075) instead of lying
// with text(); the TODO line is dropped for mapped types. Anything else still
// falls back to text() with its TODO retained so new unparsed types surface.
let fixedUnknownCols = 0;
let fixedUnknownFallback = 0;
{
  const UNPARSED_TYPE_MAP = { bytea: 'byteaCustom', tsvector: 'tsvectorCustom' };
  const used = new Set();
  const lines = schema.split('\n');
  const out = [];
  for (let li = 0; li < lines.length; li++) {
    const todo = /^\s*\/\/ TODO: failed to parse database type '([^']+)'\s*$/.exec(lines[li]);
    const mapped = todo ? UNPARSED_TYPE_MAP[todo[1]] : undefined;
    if (mapped && li + 1 < lines.length && /:\s*unknown\(/.test(lines[li + 1])) {
      out.push(lines[li + 1].replace(/:\s*unknown\(/, `: ${mapped}(`));
      used.add(mapped);
      fixedUnknownCols++;
      li++; // consume the column line; the TODO comment is resolved → dropped
      continue;
    }
    out.push(lines[li]);
  }
  schema = out.join('\n');

  // Any unknown() left (unmapped type, or no TODO marker) → old text() fallback.
  schema = schema.replace(/\w+: unknown\(/g, (match) => {
    fixedUnknownFallback++;
    return match.replace('unknown(', 'text(');
  });

  if (used.size > 0) {
    if (!/\bcustomType\b/.test(schema.split('\n')[0])) {
      schema = schema.replace(
        /^import \{ /,
        'import { customType, ',
      );
    }
    const prelude = [
      '',
      "// Custom column types for PG types drizzle-kit can't introspect",
      '// (pull-schema.mjs Fix 4, audit P-075):',
      ...(used.has('byteaCustom')
        ? ["const byteaCustom = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });"]
        : []),
      ...(used.has('tsvectorCustom')
        ? ["const tsvectorCustom = customType<{ data: string; driverData: string }>({ dataType: () => 'tsvector' });"]
        : []),
    ].join('\n');
    schema = schema.replace(
      /import \{ sql \} from "drizzle-orm"/,
      `import { sql } from "drizzle-orm"\n${prelude}`,
    );
  }
}

// Fix 5: drizzle-kit drops primary keys. Re-query PG and inject any missing
// `primaryKey({ columns: [...] })` into the table-config callback.
let fixedMissingPks = 0;
// dbUrl resolved once above (shared with the precheck) — see the comment there.
const pkQuery = [
  "SELECT n.nspname, t.relname,",
  "  string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum))",
  "FROM pg_constraint c",
  "JOIN pg_class t ON c.conrelid = t.oid",
  "JOIN pg_namespace n ON t.relnamespace = n.oid",
  "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)",
  "WHERE c.contype='p' AND n.nspname IN ('harness_shared','papercusp_shared')",
  "GROUP BY n.nspname, t.relname",
  "ORDER BY 1, 2;",
].join(' ');
const psql = spawnSync('psql', [dbUrl, '-tA', '-F', '|', '-c', pkQuery], {
  encoding: 'utf8',
});
if (psql.status === 0) {
  const compositePks = psql.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [schemaName, tableName, colsCsv] = line.split('|');
      return { schemaName, tableName, cols: colsCsv.split(',') };
    });

  /**
   * Find a table block via a brace-balanced walker.
   *
   * Why not regex: the earlier `[\s\S]*?})` non-greedy match stopped at
   * the FIRST `})` it saw — which is a column constructor like
   * `bigint({ mode: "number" })`, not the table-level close. Result:
   * Fix 5 injected `(table) => [primaryKey(...)]` INTO a column's
   * constructor args. drizzle-orm tolerated the malformed syntax;
   * drizzle-zero rejected it (UNLOCK-4-SPIKE.md blocker #1).
   *
   * Returns offsets bounding the columns-object close and the
   * table-level callback (when present), so the injection lands at the
   * correct spot for both flavors of drizzle-kit output:
   *   `}, (table) => [...])`  — callback present
   *   `})`                    — no callback
   */
  function findTableBlock(src, tableName) {
    const reEscaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);
    const openRe = new RegExp(
      'export const \\w+ = \\w+\\.table\\("' + reEscaped + '", \\{',
      'm',
    );
    const openMatch = src.match(openRe);
    if (!openMatch || openMatch.index === undefined) return null;
    const openBrace = openMatch.index + openMatch[0].length - 1;
    const n = src.length;

    // Phase 1: brace-balanced walk to find columns-object close `}`.
    let i = openBrace + 1;
    let depth = 1;
    while (i < n && depth > 0) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
      if (c === '"' || c === "'") { const q = c; i++; while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; } i++; continue; }
      if (c === '`') {
        i++;
        let tdepth = 0;
        while (i < n) {
          if (src[i] === '\\') { i += 2; continue; }
          if (tdepth === 0 && src[i] === '`') { i++; break; }
          if (src[i] === '$' && src[i + 1] === '{') { tdepth++; i += 2; continue; }
          if (tdepth > 0 && src[i] === '}') { tdepth--; i++; continue; }
          i++;
        }
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    const closeBrace = i - 1; // index of the `}` closing the columns object

    // Phase 2: from just past `}`, find the closing `)` of `.table(...)`.
    // Any nested parens (e.g. `(table) =>`, `index(...)`) are stepped
    // over by paren-balance counting. We're already INSIDE .table()
    // at this point, so the outer close is hit when parenDepth would
    // go below zero.
    let j = i; // i is one past `}`, so j sits at the first non-`}` char
    let parenDepth = 0;
    let tableCloseEnd = -1;
    while (j < n) {
      const c = src[j];
      if (c === '/' && src[j + 1] === '/') { while (j < n && src[j] !== '\n') j++; continue; }
      if (c === '/' && src[j + 1] === '*') { j += 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; j += 2; continue; }
      if (c === '"' || c === "'") { const q = c; j++; while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; } j++; continue; }
      if (c === '`') {
        j++;
        let tdepth = 0;
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue; }
          if (tdepth === 0 && src[j] === '`') { j++; break; }
          if (src[j] === '$' && src[j + 1] === '{') { tdepth++; j += 2; continue; }
          if (tdepth > 0 && src[j] === '}') { tdepth--; j++; continue; }
          j++;
        }
        continue;
      }
      if (c === '(') { parenDepth++; }
      else if (c === ')') {
        if (parenDepth === 0) { tableCloseEnd = j + 1; break; }
        parenDepth--;
      }
      j++;
    }
    if (tableCloseEnd === -1) return null;

    // Phase 3: detect whether a `, (table) => [...]` callback was
    // present between closeBrace+1 and tableCloseEnd-1.
    let p = closeBrace + 1;
    while (p < n && /\s/.test(src[p])) p++;
    let callbackStart = -1;
    let callbackArrayClose = -1;
    if (src[p] === ',') {
      callbackStart = p;
      // Find the closing `]` that pairs with the `[` in the callback body.
      // We walk between callbackStart and tableCloseEnd, tracking `[`/`]`.
      let bracketDepth = 0;
      let lastClose = -1;
      for (let k = p; k < tableCloseEnd; k++) {
        const c = src[k];
        if (c === '/' && src[k + 1] === '/') { while (k < n && src[k] !== '\n') k++; continue; }
        if (c === '/' && src[k + 1] === '*') { k += 2; while (k < n && !(src[k] === '*' && src[k + 1] === '/')) k++; k += 2; continue; }
        if (c === '"' || c === "'") { const q = c; k++; while (k < n && src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
        if (c === '`') {
          k++; let tdepth = 0;
          while (k < n) {
            if (src[k] === '\\') { k += 2; continue; }
            if (tdepth === 0 && src[k] === '`') { break; }
            if (src[k] === '$' && src[k + 1] === '{') { tdepth++; k += 2; continue; }
            if (tdepth > 0 && src[k] === '}') { tdepth--; k++; continue; }
            k++;
          }
          continue;
        }
        if (c === '[') bracketDepth++;
        else if (c === ']') { bracketDepth--; if (bracketDepth === 0) lastClose = k; }
      }
      callbackArrayClose = lastClose;
      if (callbackArrayClose === -1) return null;
    }

    return { openBrace, closeBrace, callbackStart, callbackArrayClose, tableCloseEnd };
  }

  for (const { schemaName: _s, tableName, cols } of compositePks) {
    const pkName = tableName + '_pkey';
    if (schema.includes('name: "' + pkName + '"')) continue;

    // Skip if a single-col `.primaryKey()` is already chained on the col.
    if (cols.length === 1) {
      const colRe = new RegExp(
        '\\b' + cols[0] + ': \\w+\\([^)]*\\)\\.primaryKey\\(\\)',
      );
      const blk = findTableBlock(schema, tableName);
      if (blk) {
        const slice = schema.slice(blk.openBrace + 1, blk.closeBrace);
        if (colRe.test(slice)) continue;
      }
    }

    const blk = findTableBlock(schema, tableName);
    if (!blk) continue;

    // Map PG column names → the Drizzle field name actually used in the
    // table block (snake_case under `casing:preserve`, camelCase under
    // `casing:camel`). Without this, references like `table.workspace_id`
    // resolve to undefined when the generated.ts field is `workspaceId`.
    const fieldMap = {};
    const tableSrc = schema.slice(blk.openBrace + 1, blk.closeBrace);
    for (const cm of tableSrc.matchAll(/^\s*(\w+):\s*\w+\(\s*["']([^"']+)["']/gm)) {
      fieldMap[cm[2]] = cm[1]; // pg-column-name → field-name
    }
    for (const cm of tableSrc.matchAll(/^\s*(\w+):\s*\w+\(/gm)) {
      // For columns without explicit pg-name in ctor, the field name IS
      // the PG column name (casing:preserve behavior). Don't overwrite
      // an existing camel mapping.
      if (!(cm[1] in fieldMap) && !Object.values(fieldMap).includes(cm[1])) {
        fieldMap[cm[1]] = cm[1];
      }
    }

    const pkColsArg = cols.map((c) => 'table.' + (fieldMap[c] ?? c)).join(', ');
    const pkLine = '\tprimaryKey({ columns: [' + pkColsArg + '], name: "' + pkName + '"}),';

    if (blk.callbackStart === -1) {
      // No callback yet — synthesize `, (table) => [ pkLine ]` between
      // the columns-object close `}` and the table's closing `)`.
      const insertion = ', (table) => [\n' + pkLine + '\n]';
      schema = schema.slice(0, blk.closeBrace + 1) + insertion + schema.slice(blk.closeBrace + 1);
    } else {
      // Inject pkLine inside the existing `[ ... ]`, just before the `]`.
      // callbackArrayClose is the position of `]`. Walk back over
      // whitespace; if the preceding char is `,` or `[`, we don't need
      // to add a leading `,`.
      let writeAt = blk.callbackArrayClose;
      while (writeAt > 0 && /\s/.test(schema[writeAt - 1])) writeAt--;
      const prev = schema[writeAt - 1];
      const needsLeadingComma = prev !== ',' && prev !== '[';
      const insertion = (needsLeadingComma ? ',\n' : '\n') + pkLine + '\n';
      schema = schema.slice(0, writeAt) + insertion + schema.slice(writeAt);
    }
    fixedMissingPks++;
  }
} else {
  console.warn('    skipped Fix 5 (composite PK injection): psql failed', psql.stderr);
}

// Fix 7: drizzle-kit truncates the PG default for epoch-ms timestamps at
// the `::numeric` type-cast colon, leaving unbalanced parens that break
// esbuild. Detect the specific known-broken pattern and rewrite. Same
// repair is applied to the SQL migration drizzle-kit emits alongside.
let fixedExtractDefaults = 0;
{
  const broken = ".default(sql`((EXTRACT(epoch FROM now()) * (1000)`)";
  const balanced = ".default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`)";
  const before = schema.length;
  while (schema.includes(broken)) {
    schema = schema.replace(broken, balanced);
    fixedExtractDefaults++;
  }
  // Also catch a variant where Fix 3 already wrapped the truncated
  // string (one less leading paren than the `default(` form above).
  const brokenInner = "sql`((EXTRACT(epoch FROM now()) * (1000)`";
  while (schema.includes(brokenInner)) {
    schema = schema.replace(brokenInner, "sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`");
    fixedExtractDefaults++;
  }
  void before;
}

// Repair the SQL migration drizzle-kit drops next to the schema (same
// truncation; `psql -f` would error if the broken text were ever applied
// to a fresh DB). The migration filename is timestamped — find by glob.
{
  const migDir = SCHEMA_DIR;
  const fs = await import('node:fs');
  for (const entry of fs.readdirSync(migDir)) {
    if (!/^\d{4}_.*\.sql$/.test(entry)) continue;
    const p = join(migDir, entry);
    let txt = readFileSync(p, 'utf8');
    const before = txt;
    txt = txt
      .replace(/DEFAULT \(\(EXTRACT\(epoch FROM now\(\)\) \* \(1000\) NOT NULL/g,
               'DEFAULT ((EXTRACT(epoch FROM now()) * 1000))::bigint NOT NULL');
    if (txt !== before) writeFileSync(p, txt);
  }
}

// Fix 6: rewrite relations import path from "./schema" to "./generated".
if (existsSync(relationsPath)) {
  let rel = readFileSync(relationsPath, 'utf8');
  rel = rel.replace(/from "\.\/schema"/g, 'from "./generated"');
  writeFileSync(relationsPath, rel);
}

// Fix 8: composite foreign keys can create a declaration-inference cycle when
// two generated tables reference each other. Put the explicit Drizzle extra-
// config return type at every table participating in such a cycle.
//
// Before that type-boundary pass, repair the ordered composite-FK pairs in BOTH
// generated artifacts from pg_constraint. drizzle-kit can reorder only the
// referenced side in schema.ts and collapses relations.ts to the first column;
// neither artifact is authoritative for this order (WI-40414).
const compositeForeignKeyQuery = [
  "SELECT COALESCE(json_agg(row_to_json(q) ORDER BY q.schema_name, q.table_name, q.constraint_name), '[]'::json)",
  'FROM (',
  '  SELECT con.conname AS constraint_name,',
  '    n.nspname AS schema_name, c.relname AS table_name,',
  '    fn.nspname AS foreign_schema_name, fc.relname AS foreign_table_name,',
  '    array_agg(a.attname ORDER BY u.ord) AS columns,',
  '    array_agg(fa.attname ORDER BY u.ord) AS foreign_columns',
  '  FROM pg_constraint con',
  '  JOIN pg_class c ON c.oid = con.conrelid',
  '  JOIN pg_namespace n ON n.oid = c.relnamespace',
  '  JOIN pg_class fc ON fc.oid = con.confrelid',
  '  JOIN pg_namespace fn ON fn.oid = fc.relnamespace',
  '  CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY',
  '    AS u(local_attnum, foreign_attnum, ord)',
  '  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.local_attnum',
  '  JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = u.foreign_attnum',
  "  WHERE con.contype = 'f'",
  "    AND n.nspname IN ('harness_shared','papercusp_shared')",
  '    AND cardinality(con.conkey) > 1',
  '  GROUP BY con.conname, n.nspname, c.relname, fn.nspname, fc.relname',
  ') q;',
].join(' ');
const compositeForeignKeysResult = spawnSync(
  'psql',
  [dbUrl, '-tA', '-c', compositeForeignKeyQuery],
  { encoding: 'utf8' },
);
if (compositeForeignKeysResult.status !== 0) {
  console.error(
    'failed to read authoritative composite foreign-key metadata:',
    compositeForeignKeysResult.stderr,
  );
  process.exit(1);
}

let compositeForeignKeys;
try {
  compositeForeignKeys = JSON.parse(compositeForeignKeysResult.stdout.trim() || '[]').map((row) => ({
    constraintName: row.constraint_name,
    schemaName: row.schema_name,
    tableName: row.table_name,
    foreignSchemaName: row.foreign_schema_name,
    foreignTableName: row.foreign_table_name,
    columns: row.columns,
    foreignColumns: row.foreign_columns,
  }));
} catch (error) {
  console.error(
    'composite foreign-key metadata was not valid JSON:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
}

const relationsSource = existsSync(relationsPath) ? readFileSync(relationsPath, 'utf8') : '';
const compositeForeignKeyFix = repairCompositeForeignKeyArtifacts({
  schema,
  relations: relationsSource,
  foreignKeys: compositeForeignKeys,
});
if (compositeForeignKeyFix.unresolved.length > 0) {
  console.error(
    'refusing to promote generated schema with unresolved composite foreign keys:\n  - ' +
      compositeForeignKeyFix.unresolved.join('\n  - '),
  );
  process.exit(1);
}
schema = compositeForeignKeyFix.schema;
if (existsSync(relationsPath)) {
  writeFileSync(relationsPath, compositeForeignKeyFix.relations);
}

const circularForeignKeyFix = annotateCircularForeignKeyExtraConfigs(schema);
schema = circularForeignKeyFix.schema;

// Fix 10: drizzle-kit can shift ordered operator classes between fields in a
// multi-column index (for example, applying timestamptz_ops to a text column
// and text_ops to the following timestamp column). Read the authoritative
// ordered classes from pg_index rather than inferring from generated TS types.
let fixedIndexOperatorClasses = 0;
let matchedIndexOperatorClasses = 0;
const indexOpclassQuery = [
  "SELECT COALESCE(json_agg(row_to_json(q) ORDER BY q.schema_name, q.table_name, q.index_name), '[]'::json)",
  "FROM (",
  "  SELECT n.nspname AS schema_name, t.relname AS table_name, i.relname AS index_name,",
  "    json_agg(json_build_object('opclass', opc.opcname, 'expression', u.attnum = 0) ORDER BY u.ord) AS keys",
  "  FROM pg_index ix",
  "  JOIN pg_class i ON i.oid = ix.indexrelid",
  "  JOIN pg_class t ON t.oid = ix.indrelid",
  "  JOIN pg_namespace n ON n.oid = t.relnamespace",
  "  CROSS JOIN LATERAL unnest(ix.indkey, ix.indclass) WITH ORDINALITY AS u(attnum, opclass_oid, ord)",
  "  LEFT JOIN pg_opclass opc ON opc.oid = u.opclass_oid",
  "  WHERE n.nspname IN ('harness_shared','papercusp_shared')",
  "  GROUP BY n.nspname, t.relname, i.relname",
  ") q;",
].join(' ');
const indexOpclasses = spawnSync('psql', [dbUrl, '-tA', '-c', indexOpclassQuery], {
  encoding: 'utf8',
});
if (indexOpclasses.status === 0) {
  try {
    const catalogRows = JSON.parse(indexOpclasses.stdout.trim() || '[]');
    const metadata = catalogRows.map((row) => ({
      schemaName: row.schema_name,
      tableName: row.table_name,
      indexName: row.index_name,
      opclasses: Array.isArray(row.keys) ? row.keys.map((key) => key.opclass) : [],
      expression: Array.isArray(row.keys) && row.keys.some((key) => key.expression),
    }));
    const repaired = repairIndexOperatorClasses(schema, metadata);
    schema = repaired.source;
    fixedIndexOperatorClasses = repaired.changed;
    matchedIndexOperatorClasses = repaired.matched;
  } catch (error) {
    console.warn(
      '    skipped Fix 10 (index operator-class metadata was not valid JSON):',
      error instanceof Error ? error.message : String(error),
    );
  }
} else {
  console.warn('    skipped Fix 10 (psql failed):', indexOpclasses.stderr);
}

// Fix 12 (EI-22145279419639902): drizzle-kit emits table/sequence/view
// declarations in PG catalog order, which shifts as unrelated tables are
// created elsewhere, burying real schema changes in a reorder-only diff of
// hundreds of declarations. Re-sort into a stable, name-derived order and
// alphabetize the pg-core import list so re-running this script against an
// unchanged schema is idempotent and a real change produces a minimal diff.
const declarationOrderFix = sortTopLevelDeclarations(schema);
schema = declarationOrderFix.source;
const importOrderFix = sortPgCoreImportSpecifiers(schema);
schema = importOrderFix.source;
console.log(
  `    Fix 12: stabilized declaration order (${declarationOrderFix.declarationCount} declarations` +
    `${declarationOrderFix.changed ? ', reordered' : ', already stable'}); ` +
    `pg-core import list ${importOrderFix.changed ? 'sorted' : 'already sorted'}`,
);

writeFileSync(schemaPath, schema);
console.log(`    fixed ${fixedDefaults} empty-string defaults`);
console.log(`    fixed ${fixedEmptyArrayDefaults} empty-array defaults`);
console.log(`    fixed ${fixedTimestamps} timestamptz columns (dropped invalid mode)`);
console.log(`    fixed ${fixedFnDefaults} function-call defaults (wrapped in sql\`\`)`);
console.log(`    typed ${fixedUnknownCols} unparsed columns via customType (bytea→Buffer, tsvector→string)`);
console.log(`    rewrote ${fixedUnknownFallback} still-unmapped unknown-type columns to text()`);
console.log(`    injected ${fixedMissingPks} missing primary keys`);
console.log(`    repaired ${fixedExtractDefaults} truncated EXTRACT defaults`);
console.log(
  `    aligned ${fixedIndexOperatorClasses} of ${matchedIndexOperatorClasses} index operator-class declaration(s)`,
);
console.log(
  `    typed ${circularForeignKeyFix.circularTables.length} circular composite-FK table callback(s)`,
);
console.log(
  `    repaired ${compositeForeignKeyFix.schemaChanged} composite FK schema declaration(s) and ` +
    `${compositeForeignKeyFix.relationsChanged} relation declaration(s) from PG`,
);

// EI-20012634773877104 — CLOSE THE CROSS-REPO ATOMICITY WINDOW BEFORE PROMOTING.
//
// generated.ts (this submodule) and the ALLOWLIST that classifies its
// identity-keyed columns (the SUPERPROJECT's
// identity-keyed-state-inventory.test.ts) can never land in one commit:
// git-sync commits the submodule and the superproject as separate commits and
// sweeps the whole tree on a schedule. So the moment we promote a schema
// carrying a NEW identity-keyed column, the tree is internally INCONSISTENT
// until someone adds the classification minutes later — and any gate candidate
// cut inside that window reds for the whole fleet (measured 2026-08-09: main
// held ~1h for work that was already correct 4m21s later; the class recurred
// for 10 more columns through 2026-08-31).
//
// Promotion is the ONLY way that inconsistent state reaches disk, so it is the
// one place the window can actually be closed. Refuse to promote, leave
// generated.ts untouched, and tell the author NOW — while the fix is one
// ALLOWLIST entry in their own working tree — rather than letting the fleet
// discover it as a gate red a quarter of an hour later.
//
// This does not weaken the census test's contract: it is that same assertion,
// run earlier, against the candidate schema.
const REPO_ROOT_FOR_GUARD = resolve(DB_ROOT, '../../../..');
const identityKeyedGuard = join(
  REPO_ROOT_FOR_GUARD,
  'scripts/check-identity-keyed-classification.mjs',
);
if (process.env.PAPERCUSP_SKIP_IDENTITY_KEYED_GATE === '1') {
  console.warn(
    '    ⚠ identity-keyed classification gate SKIPPED (PAPERCUSP_SKIP_IDENTITY_KEYED_GATE=1)',
  );
} else if (!existsSync(identityKeyedGuard)) {
  // Standalone submodule checkout: no superproject, so no ALLOWLIST to be
  // inconsistent with. Nothing to enforce.
  console.log('    identity-keyed classification gate: skipped (no superproject checkout)');
} else {
  const { checkIdentityKeyedClassification } = await import(
    pathToFileURL(identityKeyedGuard).href
  );
  const verdict = checkIdentityKeyedClassification({
    schemaPath,
    repoRoot: REPO_ROOT_FOR_GUARD,
  });
  if (verdict.code === 'unclassified') {
    // Remove drizzle-kit's ignored source names exactly as promotion would, so
    // aborting here cannot leave schema.ts behind for tsc to compile as a
    // stale second mirror.
    rmSync(schemaPath, { force: true });
    rmSync(relationsPath, { force: true });
    console.error(`\n${verdict.output.trim()}`);
    console.error(`\n==> REFUSING TO PROMOTE: ${verdict.message}`);
    console.error('    generated.ts is UNCHANGED — nothing inconsistent can be committed.');
    process.exit(1);
  }
  if (!verdict.ok) {
    // The check could not run, so we learned nothing. Do not claim a pass, but
    // do not wedge the fleet's migration flow either — the census test remains
    // the downstream backstop.
    console.warn(
      `    ⚠ identity-keyed classification gate UNVERIFIED (${verdict.code}): ${verdict.message}`,
    );
  } else {
    console.log('    identity-keyed classification gate: all columns classified');
  }
}

// Fix 9 / promote: copy first, then remove the ignored drizzle-kit source
// names. Leaving schema.ts behind makes tsc compile a stale second mirror.
promoteGeneratedSchemaArtifacts({ schemaPath, relationsPath, schemaDir: SCHEMA_DIR });

console.log('==> done. generated.ts + generated-relations.ts updated.');
console.log('    Inspect with: git diff src/schema/generated.ts');
