/**
 * _org-test-db.ts — shared fixture that stands up a MIGRATED throwaway org
 * database on the testcontainer + role-scoped clients, so code that routes
 * through `withWorkspace` (provisioning, auth, workspace-scoped tools) can be
 * tested against real Postgres with real RLS.
 *
 * NOT a test file (no `.integration.test.ts` suffix) — imported by them.
 *
 * ## Why it returns clients instead of wiring the real getOrgPg
 * The real `getOrgPgApp()` builds a Drizzle instance, and Drizzle's schema
 * extraction throws under apps/operator's vitest (`drizzle-orm` resolves to its
 * `src/` and `is()` reads `.constructor` of a null schema entry). So NO test
 * uses the real db-org connection path — the established pattern (see
 * voice-utterance-log.integration.test.ts) is to MOCK `withWorkspace` and run
 * its callback against a direct client. This fixture supplies the two
 * role-scoped clients that mock needs, plus the migrated schema + RLS the real
 * path assumes:
 *
 *   vi.mock('@papercusp/db-org', () => ({
 *     withWorkspace: (ws, cb) => db.appSql.begin(async (tx) => {
 *       await tx`SELECT set_config('app.workspace_id', ${ws}, true)`; // RLS scope
 *       return cb(tx);
 *     }),
 *   }));
 *
 * - `appSql`   — harness_app role, SUBJECT to RLS (what withWorkspace uses).
 * - `adminSql` — harness_admin (superuser), RLS-BYPASS, for test assertions.
 *
 * ## Full schema (post baseline rebuild)
 * The migration set is now self-contained (self-contained-migration-baseline-2026-06-02):
 * applying 000-baseline.sql (+ 107/108/109) builds the COMPLETE head schema — all tables,
 * the auth/audit schemas, RLS, and grants — so this fixture stands up the real full schema.
 * (The old "only a ~056 prefix is present / harness_slug globally unique" caveat is gone;
 * token_index is UNIQUE(workspace_id, harness_slug) as in head.)
 */
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config/pg';
// eslint-disable-next-line import/no-relative-packages -- run the real boot-path migration runner
import { applyPendingMigrations } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

// Boot pre-step — roles + the 3 extensions the baseline references — mirrors
// embedded-postgres-server/src/index.js. The squashed 000-baseline.sql uses
// vector()/gen_random_uuid()/trigram ops, so the extensions MUST exist before
// applyPendingMigrations or the baseline throws.
const FRAMEWORK_PREREQS_DDL = `
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
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

export interface OrgTestDb {
  /** harness_app role (RLS-SUBJECT) — feed this to a mocked withWorkspace. */
  appSql: postgres.Sql;
  /** harness_admin (superuser, RLS-BYPASS) — for test assertions. */
  adminSql: postgres.Sql;
  cleanup: () => Promise<void>;
}

const clientOpts = {
  max: 2,
  onnotice: () => {},
  prepare: false,
  connection: { search_path: 'harness_shared, public' },
} as const;

export async function createOrgTestDb(): Promise<OrgTestDb> {
  const containerUri = await getTestPg();
  const dbName = `org_${randomBytes(5).toString('hex')}`;

  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await maint.end({ timeout: 5 });
  }

  const u = new URL(containerUri);
  u.pathname = `/${dbName}`;
  const boot = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await boot.unsafe(FRAMEWORK_PREREQS_DDL);
  // The migration set is now self-contained (000-baseline.sql + 107+): empty→head
  // builds the COMPLETE schema, so this throws loudly on any real failure rather than
  // silently leaving a partial prefix (self-contained-migration-baseline-2026-06-02).
  await applyPendingMigrations({ client: boot, sqlDir: SQL_DIR });
  await boot.end({ timeout: 5 });

  const host = u.hostname;
  const port = u.port;
  const appSql = postgres(`postgresql://harness_app:harness_app_pwd@${host}:${port}/${dbName}`, clientOpts);
  const adminSql = postgres(`postgresql://harness_admin:harness_admin_pwd@${host}:${port}/${dbName}`, clientOpts);

  const cleanup = async () => {
    await appSql.end({ timeout: 5 }).catch(() => {});
    await adminSql.end({ timeout: 5 }).catch(() => {});
    const m = postgres(containerUri, { max: 1, onnotice: () => {} });
    try {
      await m.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } catch {
      /* best-effort */
    } finally {
      await m.end({ timeout: 5 });
    }
  };

  return { appSql, adminSql, cleanup };
}
