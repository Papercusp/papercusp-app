/**
 * gym-PG-init (P-001 / D-018): provision the DEDICATED gym Postgres database.
 *
 * A gym instance runs the real pipeline, which writes to the full papercup schema
 * (harness_shared.*, dbos.*, per-harness views), so the gym DB needs the WHOLE main
 * schema PLUS the gym-owned schema. This creates the database, the framework roles,
 * the required extensions, applies the main migration baseline (000-baseline + 107+,
 * now self-contained — gated by fresh-migrate.integration.test.ts), then the gym
 * schema. Mirrors the test fixture _org-test-db.ts, hardened for real provisioning.
 *
 * Isolated from the live operator DB (D-018): a separate database the gym owns.
 */
import postgres, { type Sql } from 'postgres';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyGymSchema, GYM_SQL_DIR } from './schema';
// eslint-disable-next-line import/no-relative-packages -- the real boot-path migration runner
import { applyPendingMigrations } from '../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The migration tree, relative to the repo root. */
const SQL_DIR_REL = join('libs', 'papercusp', 'libs', 'db', 'sql');

/**
 * Resolve the main-schema migration dir by walking UP from `startDir` to the
 * first ancestor that actually contains `libs/papercusp/libs/db/sql`.
 *
 * EI-8689: the old fixed `join(__dirname, '../../../../' + SQL_DIR_REL)` was
 * calibrated for the SOURCE layout (`packages/operator-core/lib/gym`, four
 * levels below the repo root). But operator-core is BUNDLED into
 * `apps/operator/dist-host/hono-host.mjs`, where `import.meta.url` — and thus
 * `__dirname` — sits at `apps/operator/dist-host`, only THREE levels below the
 * repo root. Up-four then overshot to `<workspace>/libs/papercusp/libs/db/sql`
 * (the workspace parent of the repo), which does not exist, so every gym-cycle
 * autoloop fire died with `ENOENT: scandir '.../libs/papercusp/libs/db/sql'`
 * (chronically red — 14 consecutive fires on gymloopharness). Walking up to the
 * real marker resolves correctly from BOTH the source and the bundled depth.
 */
export function resolveMainSqlDir(startDir: string): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 16; i += 1) {
    const candidate = join(dir, SQL_DIR_REL);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: the legacy source-relative path, so a genuinely-absent tree
  // still yields a deterministic path for the ENOENT message.
  return join(startDir, '..', '..', '..', '..', SQL_DIR_REL);
}

/** The main schema migration dir (000-baseline.sql + 107+). */
export const MAIN_SQL_DIR = resolveMainSqlDir(__dirname);

/** Comment stamped on a fully-built gym template before it is offered for cloning. */
export const GYM_TEMPLATE_READY_MARK = 'pc-gym-template-ready-v1';

/**
 * Content key for the complete gym schema (main + gym-owned migrations).
 *
 * A template is a database-level file clone, so its name must change whenever a
 * migration changes. Hashing names and raw contents makes stale schema reuse
 * impossible across source edits, while keeping the key independent of whether
 * the caller is running from the source tree or a bundled dist directory.
 */
const gymTemplateKeys = new Map<string, string>();
export function gymTemplateKey(mainSqlDir: string = MAIN_SQL_DIR): string {
  const mainDir = resolve(mainSqlDir);
  const cached = gymTemplateKeys.get(mainDir);
  if (cached) return cached;

  const hash = createHash('sha256').update('gym-template-v1\0');
  const addDirectory = (label: string, dir: string): void => {
    hash.update(`${label}\0`);
    for (const filename of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      hash.update(filename).update('\0').update(readFileSync(join(dir, filename))).update('\0');
    }
  };
  addDirectory('main', mainDir);
  addDirectory('gym', GYM_SQL_DIR);

  const key = hash.digest('hex').slice(0, 16);
  gymTemplateKeys.set(mainDir, key);
  return key;
}

/**
 * The Postgres image the gym cycle provisions its dedicated ephemeral DB from.
 *
 * EI-8784: MUST track the shipped/embedded operator's PG major AND the shared
 * integration-test container (`@papercusp/test-config` pg-container.ts,
 * `TEST_PG_IMAGE`). WI-2942 (2026-07-05) bumped BOTH the test infra and the
 * embedded operator from PG16 → PG18 ("PG16 silently ALLOWED behavior PG18
 * REJECTS, and vice versa") but MISSED this gym provisioning line, which stayed
 * on `pgvector/pgvector:pg16`. The gym applies the SAME `000-baseline.sql` the
 * operator ships, so a version skew makes provisioning drift from what the
 * passing `gym-db-init.integration.test.ts` (which runs on pg18 via getTestPg)
 * actually validates. Pinning this to pg18 keeps the live path byte-identical to
 * the green test; `gym-provision-image.test.ts` asserts it can't drift from
 * `TEST_PG_IMAGE` again.
 *
 * NOTE (EI-9101): this pin was ALSO (wrongly) credited with fixing the live
 * `CREATE DATABASE cannot run inside a transaction block` failure. A Postgres MAJOR
 * has no bearing on a transaction-block error — that was a postgres.js query-protocol
 * bug in the `CREATE DATABASE` call itself (now forced `.simple()`, see
 * `createGymDatabase`), which is why the reds kept climbing 29 → 45 after this pin.
 */
export const GYM_PROVISION_PG_IMAGE = 'pgvector/pgvector:pg18';

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

const SAFE_DB_NAME = /^[a-z_][a-z0-9_]*$/;

export interface ProvisionGymDbOpts {
  /** A maintenance DSN (connects to an existing db, e.g. `postgres`) able to CREATE DATABASE. */
  maintenanceUri: string;
  /** Name of the gym database to create. */
  dbName: string;
  /** Main schema migration dir; defaults to the repo's libs/papercusp/libs/db/sql. */
  mainSqlDir?: string;
}

/**
 * Create the gym database over `maint`, via the SIMPLE query protocol. Idempotent —
 * an already-existing database (42P04 / duplicate_database) is tolerated.
 *
 * EI-9101: `CREATE DATABASE` cannot run inside a transaction block, and postgres.js
 * sends a query through the EXTENDED (prepared) protocol — which PostgreSQL treats as
 * an implicit transaction — unless the SIMPLE protocol is forced. A bare
 * `maint.unsafe('CREATE DATABASE …')` only happens to use the simple protocol because
 * postgres@3.4.9 defaults a parameterless `unsafe` to simple; that default is
 * version/bundling-fragile, so the live bg-host gym-cycle chronically died with
 * `PostgresError: CREATE DATABASE cannot run inside a transaction block` (45 consecutive
 * reds) while the pg18 integration test — pinned to a postgres.js version that DOES
 * default to simple — kept passing. Explicitly `.simple()` (exactly as the operator boot
 * does for its own `CREATE DATABASE`) makes the single-statement simple protocol
 * guaranteed, independent of the postgres.js version. The earlier pg16→pg18 pin was a
 * misdiagnosis: a Postgres MAJOR has no bearing on a transaction-block error, which is
 * why the reds climbed 29→45 after it landed.
 */
export async function createGymDatabase(maint: Sql, dbName: string): Promise<void> {
  if (!SAFE_DB_NAME.test(dbName)) {
    throw new Error(`unsafe gym db name: ${JSON.stringify(dbName)}`);
  }
  try {
    // `.simple()` = the simple query protocol; CREATE DATABASE is rejected under the
    // extended protocol's implicit transaction ("cannot run inside a transaction block").
    await maint.unsafe(`CREATE DATABASE "${dbName}"`).simple();
  } catch (err) {
    // 42P04 = duplicate_database — fine (idempotent).
    if (!isDuplicateDatabaseError(err)) throw err;
  }
}

function isDuplicateDatabaseError(err: unknown): boolean {
  return /already exists|duplicate_database|42P04/i.test(String(err));
}

async function databaseExists(maint: Sql, dbName: string): Promise<boolean> {
  const rows = (await maint.unsafe(`SELECT 1 FROM pg_database WHERE datname = '${dbName}'`)) as unknown[];
  return rows.length > 0;
}

async function terminateDatabaseBackends(maint: Sql, dbName: string): Promise<void> {
  await maint.unsafe(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
  );
}

/** Apply the schema into one database. Templates intentionally omit the per-DB signing key. */
async function applyGymDatabaseContents(
  databaseUri: string,
  mainSqlDir: string,
  opts: { premintKey: boolean },
): Promise<void> {
  const boot: Sql = postgres(databaseUri, { max: 1, onnotice: () => {}, prepare: false });
  try {
    await boot.unsafe(FRAMEWORK_ROLES_DDL);
    await boot.unsafe(EXTENSIONS_DDL);
    await applyPendingMigrations({ client: boot, sqlDir: mainSqlDir });
    await applyGymSchema(boot);
    if (opts.premintKey) await premintSpawnSigningKey(boot);
  } finally {
    await boot.end({ timeout: 5 });
  }
}

/** Build the complete schema once per migration-set key on a PG cluster. */
async function buildGymTemplate(maintenanceUri: string, mainSqlDir: string, key: string): Promise<string> {
  const templateName = `tmpl_gym_${key}`;
  const lockName = `pc-gym-template-${key}`;
  const maint = postgres(maintenanceUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`SELECT pg_advisory_lock(hashtext('${lockName}'))`);
    try {
      const ready = (await maint.unsafe(
        `SELECT 1
           FROM pg_database d
           JOIN pg_shdescription c
             ON c.objoid = d.oid
            AND c.classoid = 'pg_database'::regclass
          WHERE d.datname = '${templateName}'
            AND c.description = '${GYM_TEMPLATE_READY_MARK}'`,
      )) as unknown[];
      if (ready.length > 0) return templateName;

      // A markless final-name database is a partial from a crashed build. Remove it
      // before rebuilding; only a ready, atomically-renamed DB is ever cloneable.
      if (await databaseExists(maint, templateName)) {
        await terminateDatabaseBackends(maint, templateName).catch(() => {});
        await maint.unsafe(`DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`).simple();
      }

      const buildName = `tmpl_gym_bld_${key}_${randomBytes(4).toString('hex')}`;
      await createGymDatabase(maint, buildName);
      const buildUri = new URL(maintenanceUri);
      buildUri.pathname = `/${buildName}`;
      try {
        // Do not put the signing key in the shared template: every target database
        // receives a fresh key below, preserving the old per-provision isolation.
        await applyGymDatabaseContents(buildUri.toString(), mainSqlDir, { premintKey: false });
        await terminateDatabaseBackends(maint, buildName).catch(() => {});
        await maint.unsafe(`ALTER DATABASE "${buildName}" RENAME TO "${templateName}"`).simple();
        await maint.unsafe(`COMMENT ON DATABASE "${templateName}" IS '${GYM_TEMPLATE_READY_MARK}'`).simple();
      } catch (err) {
        await terminateDatabaseBackends(maint, buildName).catch(() => {});
        await maint.unsafe(`DROP DATABASE IF EXISTS "${buildName}" WITH (FORCE)`).simple().catch(() => {});
        throw err;
      }
      return templateName;
    } finally {
      await maint.unsafe(`SELECT pg_advisory_unlock(hashtext('${lockName}'))`).catch(() => {});
    }
  } finally {
    await maint.end({ timeout: 5 });
  }
}

// Per-process de-duplication avoids opening one template builder per concurrent
// test file; the advisory lock in buildGymTemplate remains the cross-process guard.
const gymTemplateBuilds = new Map<string, Promise<string>>();
function getOrBuildGymTemplate(maintenanceUri: string, mainSqlDir: string): Promise<string> {
  const key = gymTemplateKey(mainSqlDir);
  const cacheKey = `${maintenanceUri}\0${key}`;
  let build = gymTemplateBuilds.get(cacheKey);
  if (!build) {
    build = buildGymTemplate(maintenanceUri, mainSqlDir, key);
    gymTemplateBuilds.set(cacheKey, build);
    // A transient build failure must not pin every later caller to the same error.
    build.catch(() => {
      if (gymTemplateBuilds.get(cacheKey) === build) gymTemplateBuilds.delete(cacheKey);
    });
  }
  return build;
}

async function createDatabaseFromTemplate(maint: Sql, dbName: string, templateName: string): Promise<boolean> {
  try {
    await maint.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${templateName}"`).simple();
    return true;
  } catch (err) {
    // Another concurrent caller may have created this target after our existence
    // check. Continue with the normal idempotent provisioning path in that case.
    if (isDuplicateDatabaseError(err)) return false;
    throw err;
  }
}

/**
 * Create + fully provision the gym database. Returns its connection URI (admin role).
 * Idempotent on the schema (CREATE ... IF NOT EXISTS + the migration tracker); the
 * CREATE DATABASE tolerates an already-existing database.
 */
export async function provisionGymDatabase(opts: ProvisionGymDbOpts): Promise<{ databaseUri: string }> {
  if (!SAFE_DB_NAME.test(opts.dbName)) {
    throw new Error(`unsafe gym db name: ${JSON.stringify(opts.dbName)}`);
  }
  const mainSqlDir = opts.mainSqlDir ?? MAIN_SQL_DIR;
  const maint = postgres(opts.maintenanceUri, { max: 1, onnotice: () => {} });
  const targetLockName = `pc-gym-database-${opts.dbName}`;
  const u = new URL(opts.maintenanceUri);
  u.pathname = `/${opts.dbName}`;
  const databaseUri = u.toString();
  try {
    // Serialize callers targeting the same DB, including a race between the
    // existence check and CREATE DATABASE. Different targets still clone in parallel.
    await maint.unsafe(`SELECT pg_advisory_lock(hashtext('${targetLockName}'))`);
    try {
      if (!(await databaseExists(maint, opts.dbName))) {
        const templateName = await getOrBuildGymTemplate(opts.maintenanceUri, mainSqlDir);
        await createDatabaseFromTemplate(maint, opts.dbName, templateName);
      }
      // Keep the target lock until the repair/key-mint step completes too. This
      // prevents two callers racing on an existing or just-cloned target's
      // schema_migrations tracker.
      await applyGymDatabaseContents(databaseUri, mainSqlDir, { premintKey: true });
    } finally {
      await maint.unsafe(`SELECT pg_advisory_unlock(hashtext('${targetLockName}'))`).catch(() => {});
    }
  } finally {
    await maint.end({ timeout: 5 });
  }

  return { databaseUri };
}

/**
 * Pre-mint the spawn-signing key so the orchestrator's `spawn-mcp` can SIGN the agent's
 * per-spawn `.mcp.json` on the very FIRST agent invoke.
 *
 * The live operator mints this key lazily, on its first signing/verify call
 * (`loadOrCreateKey` in apps/operator/lib/spawn-signing.ts). But a fresh gym DB never
 * receives such a call before the gym-operator spawns its first pipeline agent — so
 * `spawn-mcp.loadSigningKey()` reads `harness_shared.operator_secrets` for
 * `spawn-signing-key`, finds it missing, and (strict mode being the default) refuses to
 * emit an unsigned URL → the per-spawn `.mcp.json` is never written → `claude -p
 * --mcp-config <path> --strict-mcp-config` aborts with "MCP config file not found" and
 * EXIT 1, which the pipeline surfaces as "decide invoke failed (exit=1, empty=true)".
 *
 * Minting it here (idempotent) makes the first real agent run work. A 32-byte random key
 * matches what `loadOrCreateKey` would mint; both the orchestrator (signs) and the
 * gym-operator's MCP route (verifies) read this one row, so the HMAC is consistent.
 */
export async function premintSpawnSigningKey(sql: Sql): Promise<void> {
  const valueB64 = randomBytes(32).toString('base64');
  await sql`
    INSERT INTO harness_shared.operator_secrets (name, value_b64)
    VALUES ('spawn-signing-key', ${valueB64})
    ON CONFLICT (name) DO NOTHING`;
}
