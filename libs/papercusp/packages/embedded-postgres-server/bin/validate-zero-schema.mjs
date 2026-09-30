#!/usr/bin/env node
/**
 * Compare libs/zero-harness/src/schema.ts column types against the live PG.
 *
 * Why: per-memory, a TIMESTAMPTZ-vs-number mismatch in the Zero schema
 * cascades to SchemaVersionNotSupported and breaks every panel sharing
 * the same Zero schema. This validator catches that pre-flight.
 *
 * Output: pass/fail table on stderr, exit 1 if any mismatches.
 *
 * Env:
 *   PAPERCUSP_PG_PORT     (required)  embedded-postgres or system PG port
 *   PAPERCUSP_PG_USER     (default postgres)
 *   PAPERCUSP_PG_PASSWORD (default postgres)
 *   PAPERCUSP_PG_DB       (default papercusp)
 *   PAPERCUSP_ZERO_SCHEMA (default $PAPERCUSP_ROOT/libs/zero-harness/src/schema.ts)
 */

import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const ZERO_TO_PG = {
  string: new Set(['text','character varying','varchar','uuid','character']),
  // bigint timestamps are emitted by zero-cache as `number` — and so are
  // PG's actual timestamp types. The memory-noted footgun is when Zero
  // declares `string` for a TIMESTAMPTZ column.
  number: new Set(['integer','bigint','smallint','double precision','real','numeric','timestamp with time zone','timestamp without time zone']),
  boolean: new Set(['boolean']),
  json: new Set(['json','jsonb']),
};

function parseSchemaFile(schemaPath) {
  const src = readFileSync(schemaPath, 'utf8');
  const tablePat = /export\s+const\s+(\w+)\s*=\s*table\([^)]+\)\s*\.from\(['"]([^'"]+)['"]\)\s*\.columns\(\{([\s\S]*?)\}\)/g;
  const tables = [];
  let m;
  while ((m = tablePat.exec(src)) !== null) {
    const [_, tableName, pgRef, colsBlob] = m;
    if (!pgRef.includes('.')) continue;
    const [pgSchema, pgTable] = pgRef.split('.', 2);
    const cols = [];
    for (const line of colsBlob.split('\n')) {
      const trimmed = line.trim().replace(/,$/, '');
      if (!trimmed || trimmed.startsWith('//')) continue;
      const cm = trimmed.match(/^(\w+):\s*(\w+)\(\)([^,]*?)$/);
      if (!cm) continue;
      const [, zeroCol, zeroTy, rest] = cm;
      const fromMatch = (rest || '').match(/\.from\(['"]([^'"]+)['"]\)/);
      const pgCol = fromMatch ? fromMatch[1]
        : zeroCol.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      const isOpt = /\.optional/.test(rest || '');
      cols.push({ zeroCol, zeroTy, pgCol, isOpt });
    }
    tables.push({ tableName, pgSchema, pgTable, cols });
  }
  return tables;
}

async function main() {
  const port = Number(process.env.PAPERCUSP_PG_PORT);
  if (!Number.isFinite(port)) {
    console.error('PAPERCUSP_PG_PORT required');
    process.exit(2);
  }
  const user = process.env.PAPERCUSP_PG_USER ?? 'postgres';
  const password = process.env.PAPERCUSP_PG_PASSWORD ?? 'postgres';
  const database = process.env.PAPERCUSP_PG_DB ?? 'papercusp';
  const schemaPath = process.env.PAPERCUSP_ZERO_SCHEMA
    ?? `${process.cwd()}/libs/zero-harness/src/schema.ts`;

  const tables = parseSchemaFile(schemaPath);
  if (tables.length === 0) {
    console.error(`no tables parsed from ${schemaPath}`);
    process.exit(2);
  }

  const sql = postgres({
    host: '127.0.0.1', port, user, password, database, max: 1,
  });

  // One query for all (schema, table) pairs.
  const pairs = [...new Set(tables.map((t) => `('${t.pgSchema}','${t.pgTable}')`))].join(',');
  const rows = await sql.unsafe(`
    SELECT table_schema, table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE (table_schema, table_name) IN (${pairs})
  `);

  const pgTypes = new Map();
  for (const r of rows) {
    pgTypes.set(`${r.table_schema}.${r.table_name}.${r.column_name}`, {
      dt: r.data_type, nullable: r.is_nullable === 'YES',
    });
  }

  let drift = 0, missing = 0, total = 0;
  const lines = [];
  for (const t of tables) {
    for (const c of t.cols) {
      total++;
      const key = `${t.pgSchema}.${t.pgTable}.${c.pgCol}`;
      const pg = pgTypes.get(key);
      if (!pg) {
        missing++;
        lines.push(`  MISSING ${key} (zero col: ${c.zeroCol})`);
        continue;
      }
      const expected = ZERO_TO_PG[c.zeroTy] ?? new Set();
      if (!expected.has(pg.dt)) {
        drift++;
        const sev = (pg.dt === 'text' && c.zeroTy === 'number')
          ? '⚠ would cascade to SchemaVersionNotSupported'
          : (pg.dt === 'timestamp with time zone' && c.zeroTy === 'string')
            ? '⚠ TIMESTAMPTZ-as-string footgun'
            : 'mismatch';
        lines.push(`  DRIFT   ${key.padEnd(60)} pg=${pg.dt.padEnd(28)} zero=${c.zeroTy.padEnd(8)} ${sev}`);
      }
    }
  }

  await sql.end({ timeout: 2 });

  if (drift + missing === 0) {
    console.log(`✓ Zero schema clean: ${total} columns across ${tables.length} tables, all types align with PG`);
    process.exit(0);
  }
  console.error(`✗ Zero schema validation failed:`);
  for (const l of lines) console.error(l);
  console.error(`  Total: ${total}  Drift: ${drift}  Missing: ${missing}`);
  // NOT process.exit(): the drift loop above grows with the number of violations and
  // exit() does not drain an async pipe write — the WORST case here, since a truncated
  // failure list reads as fewer violations. See scripts/check-undrained-stdout-exit.mjs.
  process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
