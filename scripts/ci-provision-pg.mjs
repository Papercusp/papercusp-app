/**
 * Provision the CI Postgres service into a dev-box-parity `papercusp` DB (WI-123).
 *
 * The nightly's first real executions showed ~30 "unit"-tier suites failing with
 * ECONNREFUSED :5432 on the GitHub runner — not because the tests connect to PG
 * directly, but because app code they import resolves the default
 * `postgresql://…@localhost:5432/papercusp` (libs/papercusp/libs/db/src/connection.ts
 * resolution chain, step 3) when no env/discovery file is present. Those suites
 * pass on any box with a provisioned native :5432 (dev box, green-checkpoint
 * tree). This script gives the CI runner the same environment: a service
 * container at :5432 brought to schema-head with the REAL boot-path runner.
 *
 * Recipe mirrors the strict gate (apps/operator/test/fresh-migrate.integration.test.ts)
 * and embedded-postgres-server/src/index.js boot pre-steps:
 *   1. Framework roles (harness_app / harness_admin / harness_zero).
 *   2. `papercusp` database.
 *   3. Extensions the baseline references (pgcrypto / pg_trgm / vector) —
 *      requires a pgvector-bundling image (pgvector/pgvector:pg16).
 *   4. applyPendingMigrations over libs/papercusp/libs/db/sql — fail-loud:
 *      a broken migration must fail provisioning, not surface as 30 weird reds.
 *
 * Superuser URL comes from CI_PG_SUPERUSER_URL (the workflow's service creds);
 * local verification can point it at a throwaway container on any port.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = resolve(ROOT, 'libs/papercusp/libs/db/sql');
const DB_NAME = 'papercusp';

export const USAGE = `Usage: node scripts/ci-provision-pg.mjs [--help]
  --help, -h  Show this help and exit without connecting to PostgreSQL or applying migrations.

Without --help, provisions the CI Postgres service and applies pending migrations.`;

/**
 * Parse the read-only control flag before loading or constructing any database
 * client. Keep this pure so help can be tested without a live Postgres service.
 *
 * @param {string[]} argv
 * @returns {{ help: boolean }}
 */
export function parseArgs(argv) {
  return { help: argv.includes('--help') || argv.includes('-h') };
}

const FRAMEWORK_ROLES_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
      CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd';
    END IF;
  END $pg$;
`;

const EXTENSIONS_DDL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

function withDbName(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * Provision the database, or print help without touching the database.
 *
 * The database-only imports and client construction are deliberately lazy and
 * live after the help branch. This keeps `--help` safe for CI argument
 * discovery and makes the no-client-construction guarantee testable.
 *
 * @param {string[]} argv
 * @returns {Promise<0 | 1>}
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const { default: postgres } = await import('postgres');
  const { applyPendingMigrations } = await import(
    '../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js'
  );
  const superUrl = process.env.CI_PG_SUPERUSER_URL
    ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
  const t0 = Date.now();

  const cluster = postgres(superUrl, { max: 1, onnotice: () => {} });
  try {
    await cluster.unsafe(FRAMEWORK_ROLES_DDL);
    const exists = await cluster.unsafe(
      `SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'`,
    );
    if (exists.length === 0) await cluster.unsafe(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await cluster.end({ timeout: 5 });
  }

  // max:1 — the runner applies each migration in an explicit BEGIN/COMMIT block.
  const db = postgres(withDbName(superUrl, DB_NAME), { max: 1, onnotice: () => {} });
  try {
    await db.unsafe(EXTENSIONS_DDL);
    const { appliedCount, totalKnown, failed } = await applyPendingMigrations({
      client: db,
      sqlDir: SQL_DIR,
      log: (s) => console.log(`[ci-provision-pg] ${s}`),
    });
    if (failed.length > 0) {
      console.error(`[ci-provision-pg] FAILED migrations: ${JSON.stringify(failed)}`);
      return 1;
    }
    const tables = await db.unsafe(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'harness_shared'`,
    );
    console.log(
      `[ci-provision-pg] ${DB_NAME} at schema head: applied ${appliedCount}/${totalKnown} files, `
      + `${tables[0].n} harness_shared tables, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  } finally {
    await db.end({ timeout: 5 });
  }
  return 0;
}

if (isCliEntry(import.meta.url)) process.exitCode = await main();
