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
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb } from '@papercusp/test-config/pg';
// eslint-disable-next-line import/no-relative-packages -- run the real boot-path migration runner
import { applyPendingMigrations } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';
// EI-18698602043482898: mirror the canonical getOrgPg()/getHarnessPg() client
// shape (bigint-as-number types + the raw Date/jsonb serializer restorers) so
// this fixture's raw `sql` writes bind parameters the SAME way production
// does — without those, a raw jsonb/bigint/Date write here can pass or fail
// in the OPPOSITE direction from the live code path (see connection.ts's
// `restoreRawJsonbSerializer` doc). Deliberately imported from the
// dependency-free `raw-serializers` module (not `@papercusp/db-org`'s
// `connection.ts`/barrel), which drags in `drizzle-orm/postgres-js` — see the
// module docstring above for why that throws under this package's vitest.
// eslint-disable-next-line import/no-relative-packages -- mirror the canonical client's postgres-js options without pulling in drizzle-orm
import {
  PG_BIGINT_AS_NUMBER_TYPES,
  PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES,
  restoreRawDateSerializers,
  restoreRawJsonbSerializer,
  seedBuiltinArrayTypes,
  installNumericArrayTyping,
} from '../../../libs/papercusp/libs/db/src/raw-serializers';

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
      CREATE ROLE harness_zero LOGIN REPLICATION NOSUPERUSER BYPASSRLS PASSWORD 'harness_zero_pwd';
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
  /** DSN of the harness_app client — for env-routing the REAL getOrgPgApp()
   *  (`HARNESS_DATABASE_URL`) the way _baseline-coord-fixture does. */
  appDsn: string;
  /** DSN of the harness_admin client — for `HARNESS_ADMIN_DATABASE_URL` /
   *  `DATABASE_URL` env-routing and as a DBOS systemDatabaseUrl. */
  adminDsn: string;
  /** The throwaway database name (diagnostics). */
  dbName: string;
  cleanup: () => Promise<void>;
}

const clientOpts = {
  max: 2,
  onnotice: () => {},
  prepare: false,
  connection: { search_path: 'harness_shared, public' },
  // EI-9265: mirror the canonical client's bigint-as-number parsing so a raw
  // bigserial read (e.g. an `id` PK) comes back as a JS number here exactly
  // like it does through getOrgPg()/getHarnessPg(), not a string.
  // EI-19331550321709126: also mirror the OID-1114 (bare `timestamp`)
  // UTC-forced parser — without it, this fixture would parse a computed
  // `AT TIME ZONE 'UTC'` expression as server-local, the OPPOSITE of what
  // production's buildClient() does, and a test against this fixture could
  // pass while the real path is corrupted (or vice versa).
  types: { ...PG_BIGINT_AS_NUMBER_TYPES, ...PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES },
};

/** Apply every client fix `buildClient` (in the canonical `@papercusp/db-org`
 *  connection layer) installs on a production client — see `raw-serializers.ts`'s
 *  docs. Without these, THIS fixture's clients bind parameters differently than
 *  production does: a raw Date or jsonb write (EI-18698602043482898), or a
 *  `sql.array(...)` on a cold pool, sent as `text` instead of `text[]`/`bigint[]`
 *  (WI-10004177). lib/__tests__/org-test-db-client-fixes-parity.test.ts fails if
 *  buildClient gains a fix this function does not apply. */
function applyRawSerializerFixes(client: postgres.Sql): postgres.Sql {
  restoreRawDateSerializers(client);
  restoreRawJsonbSerializer(client);
  seedBuiltinArrayTypes(client);
  installNumericArrayTyping(client);
  return client;
}

let _migKey: string | null = null;
/** Content hash of the migration set — the template key. Changes whenever any migration
 *  is added / edited / removed, so a schema change forces a template rebuild (a stale
 *  template would silently serve the WRONG schema). Computed once per process. */
export function migrationSetKey(): string {
  if (_migKey) return _migKey;
  const h = createHash('sha1');
  for (const f of readdirSync(SQL_DIR).filter((n) => n.endsWith('.sql')).sort()) {
    h.update(f).update('\0').update(readFileSync(resolve(SQL_DIR, f)));
  }
  _migKey = h.digest('hex').slice(0, 16);
  return _migKey;
}

/** Public name used by the integration globalSetup that pre-warms this template. */
export function orgTemplateKey(): string {
  return migrationSetKey();
}

/** Build the complete org fixture schema into a template database. */
export async function provisionOrgTemplate(url: string): Promise<{ migrationCount: number }> {
  const boot = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await boot.unsafe(FRAMEWORK_PREREQS_DDL);
    // empty→head builds the COMPLETE schema, throwing loudly on any real failure
    // (self-contained-migration-baseline-2026-06-02).
    const result = await applyPendingMigrations({ client: boot, sqlDir: SQL_DIR });
    return { migrationCount: result.totalKnown };
  } finally {
    await boot.end({ timeout: 5 });
  }
}

export interface CreateOrgTestDbOptions {
  /** Size of the `adminSql` pool (default {@link clientOpts}.max = 2). A rig that
   *  stands `adminSql` in for getOrgPg() and MEASURES concurrency must size it like
   *  the production admin pool, or the pool, not the code under test, sets the
   *  concurrent throughput (P-013 D-024). */
  adminPoolMax?: number;
}

export async function createOrgTestDb(opts: CreateOrgTestDbOptions = {}): Promise<OrgTestDb> {
  const adminPoolMax = opts.adminPoolMax ?? clientOpts.max;
  if (!Number.isInteger(adminPoolMax) || adminPoolMax < 1) {
    throw new Error(`createOrgTestDb: adminPoolMax must be a positive integer, got ${String(opts.adminPoolMax)}`);
  }
  // Clone the fully-migrated schema from a per-container TEMPLATE built ONCE
  // (FRAMEWORK_PREREQS_DDL + ~280 migrations) instead of replaying it for EVERY
  // integration file — a near-instant Postgres `CREATE DATABASE … TEMPLATE` file
  // copy. The template is keyed by the migration-set content hash, so a schema
  // change rebuilds it (else a stale template serves the wrong schema).
  const db = await createFreshTestDb({
    prefix: 'org',
    template: {
      key: orgTemplateKey(),
      provision: provisionOrgTemplate,
    },
  });
  const dbName = db.name;
  const u = new URL(db.url);
  const host = u.hostname;
  const port = u.port;
  const appDsn = `postgresql://harness_app:harness_app_pwd@${host}:${port}/${dbName}`;
  const adminDsn = `postgresql://harness_admin:harness_admin_pwd@${host}:${port}/${dbName}`;
  const appSql = applyRawSerializerFixes(postgres(appDsn, clientOpts));
  const adminSql = applyRawSerializerFixes(postgres(adminDsn, { ...clientOpts, max: adminPoolMax }));

  const cleanup = async () => {
    // The two clients are independent. Waiting for their five-second shutdown
    // ceilings serially can consume Vitest's entire default 10s afterAll budget
    // before db.drop() even starts, turning green integration assertions red at
    // teardown. Close them concurrently so the lifecycle ceiling is one client
    // timeout plus the drop, not the sum of both timeouts.
    await Promise.all([
      appSql.end({ timeout: 5 }).catch(() => {}),
      adminSql.end({ timeout: 5 }).catch(() => {}),
    ]);
    await db.drop().catch(() => {});
  };

  return { appSql, adminSql, appDsn, adminDsn, dbName, cleanup };
}
