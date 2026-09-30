/**
 * Deploy-time migration apply — plan release-gate-ready-branch-2026-06-04, D-007.
 *
 * Schema is coupled to code, so a migration deploys ATOMICALLY WITH the code it
 * belongs to: the deploy script applies the pending `sql/*.sql` from the RELEASE
 * tree to the operator DB at swap time, and agents stop applying migrations to
 * the live DB out of band (Phase 3). Unlike boot-time apply (log-and-continue so
 * a broken peer migration never wedges the shared dev-api), the DEPLOY apply is
 * FAIL-LOUD: a failed migration aborts the deploy → rollback, because we're
 * deploying a vetted green-`main` state and a failure means that state is not safe.
 *
 * The migration-number COLLISION the plan calls out (two agents staging the same
 * NNN) is already prevented upstream by the atomic allocator (`db:next-migration`
 * → harness_shared.migration_reservations + advisory lock); this is the apply end.
 *
 * Parameterised (sqlDir / dbUrl) so it's testable against a throwaway DB without
 * touching the live operator DB.
 */

import postgres from 'postgres';
import * as fs from 'node:fs';
import * as path from 'node:path';
// Types come from the package's generated `src/index.d.ts` (EI-18804531117413708).
// This was the THIRD verbatim copy of the same `@ts-expect-error` + hand-written
// `ApplyPendingMigrations` cast (with db-boot-migrate.ts and
// release-preflight-migration-boot-smoke.integration.test.ts). Being outside
// operator-core, it was invisible to `lint:tsc` — so it never even showed up as
// a TS7016; only the duplicated shape gave it away.
import { applyPendingMigrations } from '@papercusp/embedded-postgres-server';
import { getHarnessAdminUrl } from '@papercusp/operator-core/lib/embedded-pg-discovery';
import { readMigratePolicy } from '@papercusp/operator-core/lib/migrate-policy';
import {
  resolveDeployedReleaseRoot,
  verifyPendingCodeDeployMigration,
} from '@papercusp/operator-core/lib/migration-deploy-guard';

type MigrationClient = ReturnType<typeof postgres>;

type SchemaCreatePrivilege = {
  query_role: string;
  schema_owner: string;
  has_create: boolean;
};

const SCHEMA_QUALIFIED_CREATE =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))\s*\./gi;

/**
 * Existing schemas a migration will create objects in.
 *
 * This intentionally ignores CREATE INDEX: PostgreSQL authorizes that against
 * the target table owner, not the schema CREATE privilege. Comments are removed
 * first so a runbook example in a migration cannot invent a false dependency.
 */
export function migrationCreateSchemas(rawSql: string): string[] {
  const sql = rawSql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ');
  const schemas = new Set<string>();
  for (const match of sql.matchAll(SCHEMA_QUALIFIED_CREATE)) {
    const schema = match[1]?.replaceAll('""', '"') ?? match[2];
    if (schema) schemas.add(schema);
  }
  return [...schemas].sort();
}

/**
 * Fail before executing a migration whose connection role cannot create the
 * schema-qualified objects it declares.
 *
 * Native Postgres deliberately keeps `harness_admin` non-superuser, while the
 * embedded/test role is superuser. Without this check that test topology masks
 * a live ACL mismatch until deploy-time DDL throws a raw "permission denied for
 * schema" after the release checkout has already swapped (EI-21233784335643404).
 */
export async function assertMigrationCreatePrivileges(
  client: MigrationClient,
  filename: string,
  rawSql: string,
): Promise<void> {
  for (const schema of migrationCreateSchemas(rawSql)) {
    const literal = schema.replaceAll("'", "''");
    const rows = (await client.unsafe(`
      SELECT current_user AS query_role,
             pg_get_userbyid(n.nspowner) AS schema_owner,
             has_schema_privilege(current_user, n.oid, 'CREATE') AS has_create
        FROM pg_namespace n
       WHERE n.nspname = '${literal}'
    `)) as unknown as SchemaCreatePrivilege[];
    const privilege = rows[0];
    // A missing schema is governed by database CREATE permission and will be
    // created by the migration itself. This guard targets the distinct existing-
    // schema ACL class that PostgreSQL otherwise reports only at object creation.
    if (!privilege || privilege.has_create) continue;
    throw new Error(
      `[migrate] ${filename}: migration role ${privilege.query_role} lacks CREATE on existing schema ${schema} ` +
        `(owner ${privilege.schema_owner}); grant CREATE on that schema to ${privilege.query_role} before retrying`,
    );
  }
}

export interface MigrateOpts {
  /** Defaults to <releaseRoot>/libs/papercusp/libs/db/sql, else cwd-relative. */
  sqlDir?: string;
  releaseRoot?: string;
  /** Revision the currently-running operator serves before this deploy cuts over. */
  deployedSha?: string | null;
  /** Defaults to getHarnessAdminUrl() (embedded-pg discovery / DATABASE_URL). */
  dbUrl?: string;
  log?: (s: string) => void;
}

export interface MigrateResult {
  appliedCount: number;
  totalKnown: number;
  /** Filenames newly applied this run (computed from the tracker before/after). */
  applied: string[];
  sqlDir: string;
}

function defaultSqlDir(releaseRoot?: string): string | null {
  const candidates = [
    releaseRoot ? path.join(releaseRoot, 'libs/papercusp/libs/db/sql') : null,
    path.resolve(process.cwd(), 'libs/papercusp/libs/db/sql'),
    path.resolve(process.cwd(), '../../libs/papercusp/libs/db/sql'),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function appliedSet(client: ReturnType<typeof postgres>): Promise<Set<string>> {
  try {
    const rows = await client<Array<{ filename: string }>>`
      SELECT filename FROM harness_shared.schema_migrations ORDER BY filename`;
    return new Set(rows.map((r) => r.filename));
  } catch {
    return new Set(); // tracker not created yet (fresh DB)
  }
}

/**
 * Apply all pending migrations to the target DB, FAIL-LOUD. Throws on the first
 * failed migration (deploy aborts → rollback). Returns the list newly applied.
 */
export async function applyStagedMigrations(opts: MigrateOpts = {}): Promise<MigrateResult> {
  const sqlDir = opts.sqlDir ?? defaultSqlDir(opts.releaseRoot);
  if (!sqlDir || !fs.existsSync(sqlDir)) {
    throw new Error(`[migrate] sql dir not found (sqlDir=${sqlDir ?? 'null'})`);
  }
  const dbUrl = opts.dbUrl ?? getHarnessAdminUrl();
  const log = opts.log ?? ((s: string) => console.log(`[migrate] ${s}`));

  // Dedicated max:1 client — the runner applies each file as a raw
  // BEGIN; <ddl>; COMMIT; via .unsafe(), rejected on a pooled connection.
  //
  // lock_timeout (root-caused 2026-06-08): a DDL that cannot acquire its lock
  // quickly must ABORT, not queue. A migration `ALTER TABLE … ADD COLUMN` needs
  // ACCESS EXCLUSIVE; if a pg_dump backup holds ACCESS SHARE on that table, the
  // ALTER queues — and a *queued* ACCESS EXCLUSIVE blocks ALL access to the
  // table (even reads) for the backup's whole duration, wedging the table and
  // everything that reads it (e.g. coord_event_log → coord → the psu bootstrap
  // routes hung for 37 min). Fail-fast → the migration is left pending and
  // retried, instead of taking the table down. application_name makes a stuck
  // migration self-identify in pg_stat_activity.
  // lock_timeout / statement_timeout are runtime-settable via db:migrate-policy
  // (live-configurability-audit P-003) — FAIL-SAFE to the 15s default if the policy (or its
  // table) can't be read (CLI path / fresh DB / pre-migration / no org-pg context).
  let lockTimeoutMs = 15_000;
  let statementTimeoutMs: number | null = null;
  try {
    const pol = await readMigratePolicy();
    lockTimeoutMs = pol.lockTimeoutMs;
    statementTimeoutMs = pol.statementTimeoutMs;
  } catch (e) {
    log(`migrate-policy read failed, using defaults (lock_timeout=${lockTimeoutMs}): ${e instanceof Error ? e.message : e}`);
  }
  const client = postgres(dbUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: {
      lock_timeout: lockTimeoutMs,
      application_name: 'papercusp-deploy-migrate',
      ...(statementTimeoutMs != null ? { statement_timeout: statementTimeoutMs } : {}),
    },
  });
  try {
    const before = await appliedSet(client);
    const deployedReleaseRoot = opts.releaseRoot ?? resolveDeployedReleaseRoot(sqlDir);
    const deployedRefWasProvided = Object.prototype.hasOwnProperty.call(opts, 'deployedSha');
    const { appliedCount, totalKnown, failed } = await applyPendingMigrations({
      client,
      sqlDir,
      continueOnError: false, // FAIL-LOUD — a deploy migration failure aborts the deploy
      log,
      beforeApply: async (filename, rawSql) => {
        await assertMigrationCreatePrivileges(client, filename, rawSql);
        const guard = verifyPendingCodeDeployMigration({
          filename,
          sqlText: rawSql,
          releaseRoot: deployedReleaseRoot,
          ...(deployedRefWasProvided ? { deployedRef: opts.deployedSha } : {}),
        });
        if (!guard.ok) throw new Error(`[migration-deploy-guard] ${guard.error}`);
      },
    });
    if (failed.length > 0) {
      throw new Error(
        `[migrate] ${failed.length} migration(s) failed: ` +
          failed.map((f) => `${f.file}: ${f.error}`).join('; '),
      );
    }
    const after = await appliedSet(client);
    const applied = [...after].filter((f) => !before.has(f)).sort();
    log(`applied ${appliedCount} of ${totalKnown} known migration(s)`);
    return { appliedCount, totalKnown, applied, sqlDir };
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

// CLI: `tsx migrate.ts [--db <url>] [--sql-dir <dir>]`
if (require.main === module) {
  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  applyStagedMigrations({ dbUrl: arg('--db'), sqlDir: arg('--sql-dir') })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      // NOT process.exit(): it does not drain an async pipe write, so `migrate | jq`
      // would silently truncate this report. See scripts/check-undrained-stdout-exit.mjs.
      process.exitCode = 0;
    })
    .catch((e) => {
      console.error('[migrate] FAILED:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
