#!/usr/bin/env node
/**
 * Build a pre-migrated LOGICAL seed for the desktop first-boot fast path.
 *
 * Boots embedded-postgres into a throwaway data dir via the SAME
 * `startEmbeddedPostgresServer` code path the runtime uses (initdb + framework
 * roles + extensions + apply ALL migrations + publication), then pg_dump's the
 * migrated database into one custom-format `.dump`. A fresh install first runs
 * its OWN initdb (unique system_identifier), restores this logical archive, and
 * applies only migration deltas (see `src/index.js` seedPath handling).
 *
 * The dump is PostgreSQL-major compatible rather than a physical cluster copy.
 * It intentionally contains no pg_control / system_identifier, postmaster
 * paths, or build-box PGDATA ownership.
 *
 * Usage:
 *   node build-seed.mjs --data <tmp-pgdata> --sql <migrations-dir> --out <seed.dump> [--port 5544] [--pg-dump pg_dump]
 * Env fallbacks: PAPERCUSP_PG_DATA_DIR, PAPERCUSP_PG_SQL_DIR,
 * PAPERCUSP_PG_SEED_OUT, PAPERCUSP_PG_PORT, PAPERCUSP_PG_DUMP_BIN
 */
import { startEmbeddedPostgresServer, confLcNonPortable } from '../src/index.js';
import postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { rm, mkdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function arg(flag, envKey, def) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[envKey] ?? def;
}

const dataDir = arg('--data', 'PAPERCUSP_PG_DATA_DIR');
const sqlDir = arg('--sql', 'PAPERCUSP_PG_SQL_DIR');
const outPath = arg('--out', 'PAPERCUSP_PG_SEED_OUT');
const port = Number(arg('--port', 'PAPERCUSP_PG_PORT', '5544'));
const pgDumpBin = arg('--pg-dump', 'PAPERCUSP_PG_DUMP_BIN', 'pg_dump');

if (!dataDir || !sqlDir || !outPath) {
  console.error('build-seed: --data, --sql and --out (or their PAPERCUSP_PG_* env vars) are required');
  process.exit(2);
}
if (!existsSync(sqlDir)) {
  console.error(`build-seed: migrations dir not found at ${sqlDir}`);
  process.exit(2);
}

// Force a from-scratch initdb+migrate for the snapshot; never seed-from-seed.
process.env.PAPERCUSP_PG_DISABLE_SEED = '1';

const log = (m) => console.log(`[build-seed] ${m}`);
let handle = null;
let ok = true;
try {
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  log(`booting embedded-pg into ${dataDir} (initdb + apply migrations from ${sqlDir}) ...`);
  const t = Date.now();
  handle = await startEmbeddedPostgresServer({ dataDir, port, dbSqlDir: sqlDir, onLog: () => {} });

  // Sanity: the seed must have the full schema, else shipping it would mask a build break.
  const sql = postgres({ host: 'localhost', port, user: 'postgres', password: 'postgres', database: 'papercusp', max: 1, onnotice: () => {} });
  let migCount = 0;
  let sourceSystemIdentifier = '';
  try {
    const r = await sql.unsafe(`
      SELECT
        count(*)::int AS n,
        (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier
      FROM harness_shared.schema_migrations
    `);
    migCount = r[0].n;
    sourceSystemIdentifier = r[0].system_identifier;
  } finally { await sql.end({ timeout: 2 }).catch(() => {}); }
  if (migCount < 100) {
    throw new Error(`seed sanity check failed: only ${migCount} migrations recorded (expected the full set)`);
  }
  log(`built schema in ${Date.now() - t} ms — ${migCount} migrations recorded`);

  // WI-2749 recurrence guard: the shipped seed's postgresql.conf must name ONLY
  // portable lc_* — a host-specific locale (en_US.utf8) baked here FATALs the
  // postmaster on the lean Windows WSL rootfs at first boot. startEmbeddedPostgresServer
  // normalizes on boot, but assert on the actual on-disk artifact so a future
  // regression (removed normalizer, changed package) fails the BUILD, not the user.
  const conf = await readFile(join(dataDir, 'postgresql.conf'), 'utf8');
  const badLc = confLcNonPortable(conf);
  if (badLc.length) {
    throw new Error(
      `seed postgresql.conf carries NON-PORTABLE locale(s): ${badLc.join(', ')} — `
      + `would FATAL first boot on a C/C.utf8/POSIX-only rootfs (WI-2749)`,
    );
  }
  log('seed locale portability check passed (all lc_* portable)');

  // Dump the database LOGICALLY while the clean, migration-complete server is
  // running. `--no-owner` prevents build-box role ownership from leaking into
  // the target, while privileges are intentionally retained because the runtime
  // creates the framework roles before restore. Custom format is compressed and
  // transactional at restore time. Crucially, pg_dump cannot serialize
  // pg_control/system_identifier: every target runs its own initdb first.
  await mkdir(dirname(outPath), { recursive: true });
  await rm(outPath, { force: true }).catch(() => {});
  log(`writing logical seed → ${outPath}`);
  execFileSync(
    pgDumpBin,
    [
      '--format=custom',
      '--no-owner',
      '--host', 'localhost',
      '--port', String(port),
      '--username', 'postgres',
      '--dbname', 'papercusp',
      '--file', outPath,
    ],
    {
      env: { ...process.env, PGPASSWORD: 'postgres' },
      stdio: 'inherit',
    },
  );

  const { size } = await stat(outPath);
  log(
    `logical seed built: ${(size / 1024 / 1024).toFixed(1)} MB; `
    + `source system_identifier ${sourceSystemIdentifier} intentionally not serialized`,
  );

  log('stopping postgres cleanly ...');
  await handle.stop();
  handle = null;
} catch (e) {
  console.error(`[build-seed] FAILED: ${e?.stack ?? e?.message ?? e}`);
  ok = false;
} finally {
  if (handle) await handle.stop().catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
// A failed seed build MUST be a red build. `process.exitCode = 1` alone was
// observed to exit 0 anyway — embedded-pg's own cleanup on the failure path
// resets the code — so the packaging wrapper's `if node build-seed.mjs; then`
// took the SUCCESS branch and shipped a bundle with NO seed. First boot then
// falls back to initdb + full migration replay, which re-hits the very
// migration failure that broke the seed (e.g. a view migration that can't
// apply on a fresh DB) and CRASHES the operator before it can serve — the
// exact WI-2902 first-boot failure. Exit hard + explicitly so a broken
// migration set is caught at BUILD time, never shipped.
if (!ok) process.exit(1);
