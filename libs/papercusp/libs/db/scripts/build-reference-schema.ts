#!/usr/bin/env -S npx tsx
/**
 * build-reference-schema.ts — build a REAL Postgres reference database by
 * applying every current migration (`000-baseline.sql` +
 * `libs/papercusp/libs/db/sql/*.sql`, in order, via the SAME idempotent
 * runner the operator boots with) to a scratch database, then
 * `pg_dump --schema-only` it to a raw SQL file.
 *
 * EI-13913: this generator (named in `000-baseline.sql`'s own header —
 * "regenerate via build-reference-schema.ts → sanitize-baseline.ts" — and
 * originally specced in `docs/superpowers/specs/2026-06-02-self-contained-
 * migration-baseline-design.md` Phase 0) had been deleted from the tree with
 * nothing wired to replace it, leaving the ONE file the header forbids
 * hand-editing with no working regeneration path. This restores it.
 *
 * This is step 1 of the two-step pipeline:
 *
 *   build-reference-schema.ts  →  sanitize-baseline.ts  →  000-baseline.sql
 *   (this file: scratch DB,        (idempotency transform,   (the committed,
 *    migrate, pg_dump --schema-only)  DDL rewrite)              generated file)
 *
 * ── What "regenerate" means TODAY (read before using this for a real re-squash) ──
 *
 * The ORIGINAL 2026-06-02 squash (plan decision D1) froze `000-baseline.sql`
 * at the schema as of migration 106 and archived migrations 001–103 to
 * `sql/archive/`. That original generator also had to invoke ~65
 * `ensureXxx()` runtime-DDL functions (`ensure-schema.ts`) — those were
 * DELETED in that same plan's Phase 2 (schema changes are migrations-only
 * now: see storage-policy / CLAUDE.md), so this rewrite has no equivalent
 * step and needs none.
 *
 * Migrations 107+ are NOT folded back into the baseline — they apply ON TOP
 * of it, forever, exactly like any other migration-based schema. That means:
 *
 *   Feeding THIS script's output through sanitize-baseline.ts will NOT
 *   byte-match the CURRENTLY COMMITTED `000-baseline.sql` in normal
 *   operation — it produces the FULL current schema (baseline + every
 *   migration through head), which is strictly bigger. That is not drift;
 *   it is the expected shape of a migration set that has grown since the
 *   last squash.
 *
 * So this tool is for a DELIBERATE, occasional RE-SQUASH (compacting 107+
 * back into a new baseline + archiving them + resuming numbering above the
 * new squash point) — run it, feed the output through sanitize-baseline.ts,
 * review the diff by hand, and only then replace the committed file. That
 * file is a protected path (`libs/papercusp/libs/db/sql/**`) — get any
 * replacement reviewed before it lands.
 *
 * It is NOT a per-CI drift gate. That already exists and stays green
 * continuously: `apps/operator/test/fresh-migrate.integration.test.ts` (the
 * "STRICT SUCCESS GATE") applies baseline + every migration to a real, empty
 * Postgres on every integration run and asserts a complete, idempotent
 * schema with zero skips. THAT test is what protects against the WI-5216
 * class of baseline/migration-set divergence day to day; this script is the
 * occasional re-squash tool, not a substitute for it.
 *
 * Usage:
 *   npm run gen:baseline
 *     → runs this script + sanitize-baseline.ts, writes ONLY to /tmp
 *       (never touches the committed file).
 *   Manual / step-by-step:
 *     npx tsx libs/papercusp/libs/db/scripts/build-reference-schema.ts [outRawPath]
 *     npx tsx packages/operator-core/lib/db-tools/sanitize-baseline.ts [outRawPath] [out]
 *
 * Env:
 *   HARNESS_ADMIN_DATABASE_URL / DATABASE_URL / PAPERCUSP_PG_URL
 *     Admin connection used to CREATE/DROP the scratch database and apply
 *     migrations (default: native dev box,
 *     postgres://harness_admin:harness_admin_pwd@localhost:5432/papercusp).
 *   PAPERCUSP_PG_BOOTSTRAP_URL
 *     A REAL Postgres superuser connection, used ONLY for the boot prereqs
 *     (CREATE ROLE / CREATE EXTENSION). Defaults to the admin URL above,
 *     which is correct for embedded-pg / a fresh testcontainer (their admin
 *     role IS a real initdb superuser). On the shared NATIVE dev box,
 *     `harness_admin` is deliberately NOT superuser (only Create DB + Bypass
 *     RLS — `CREATE EXTENSION vector` needs real superuser there), so pass
 *     e.g. PAPERCUSP_PG_BOOTSTRAP_URL=postgres://postgres_app:postgres@localhost:5432/postgres.
 *
 * Flags:
 *   --schemas=a,b   pg_dump --schema-only scope (default: harness_shared,papercusp_shared —
 *                   includes the canonical messaging schema after migrations;
 *                   migrations 109+ add papercusp_auth/audit ON TOP, deliberately excluded
 *                   here — see fresh-migrate.integration.test.ts's note on that original
 *                   blind spot; pass --schemas=harness_shared,papercusp_shared,papercusp_auth,audit
 *                   for a from-scratch re-squash that folds them in too).
 *   --keep-db       don't drop the scratch database on exit (debugging).
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import postgres from 'postgres';
// Same shape db-boot-migrate.ts / the fresh-migrate.integration.test.ts STRICT
// SUCCESS GATE pin. (This import used to carry a `@ts-expect-error untyped JS
// package`; the package now ships `types: src/index.d.ts`, so the directive had
// become stale — and an UNUSED @ts-expect-error is itself a hard tsc error.
// Nothing caught that until EI-19302566985147894 gave this package a tsconfig.)
import { applyPendingMigrations } from '@papercusp/embedded-postgres-server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '..', 'sql');

const DEFAULT_ADMIN_URL = 'postgres://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
const DEFAULT_SCHEMAS = ['harness_shared', 'papercusp_shared'];

// Same boot pre-migration step embedded-postgres-server/src/index.js runs
// (framework roles + the 3 extensions the migrations reference) — mirrored
// verbatim from apps/operator/test/fresh-migrate.integration.test.ts's
// BOOT_PREREQS_DDL, the proven equivalent used by the STRICT SUCCESS GATE.
const BOOT_PREREQS_DDL = `
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

interface Args {
  outRawPath: string;
  schemas: string[];
  keepDb: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let schemas = DEFAULT_SCHEMAS;
  let keepDb = false;
  for (const a of argv) {
    if (a.startsWith('--schemas=')) {
      schemas = a
        .slice('--schemas='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--keep-db') {
      keepDb = true;
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  return {
    outRawPath: positional[0] ?? '/tmp/papercusp-reference-schema.raw.sql',
    schemas,
    keepDb,
  };
}

function adminUrl(): string {
  return (
    process.env.HARNESS_ADMIN_DATABASE_URL ??
    process.env.DATABASE_URL ??
    process.env.PAPERCUSP_PG_URL ??
    DEFAULT_ADMIN_URL
  );
}

/** A real Postgres superuser connection for boot prereqs (roles + extensions).
 *  See the module docstring's PAPERCUSP_PG_BOOTSTRAP_URL note. */
function bootstrapUrl(): string {
  return process.env.PAPERCUSP_PG_BOOTSTRAP_URL ?? adminUrl();
}

function swapDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(SQL_DIR)) {
    console.error(`[build-reference-schema] sql dir not found at ${SQL_DIR}`);
    process.exit(1);
  }

  const base = adminUrl();
  const bootstrap = bootstrapUrl();
  const dbName = `refschema_${randomBytes(6).toString('hex')}`;
  const scratchUrl = swapDbName(base, dbName);
  const scratchBootstrapUrl = swapDbName(bootstrap, dbName);

  console.log(`[build-reference-schema] admin: ${new URL(base).host} → scratch db "${dbName}"`);

  const admin = postgres(base, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  let failed = false;
  try {
    console.log('[build-reference-schema] boot prereqs (roles + extensions)…');
    // A SEPARATE, real-superuser connection (see PAPERCUSP_PG_BOOTSTRAP_URL) —
    // on the shared native dev box the admin role (harness_admin) is
    // deliberately NOT superuser and can't CREATE EXTENSION.
    const bootstrapSql = postgres(scratchBootstrapUrl, { max: 1, onnotice: () => {} });
    try {
      await bootstrapSql.unsafe(BOOT_PREREQS_DDL);
    } finally {
      await bootstrapSql.end({ timeout: 5 });
    }

    // max:1 — the runner applies each migration as an explicit BEGIN/COMMIT
    // block via .unsafe(); postgres-js rejects that on a pooled (max>1) client.
    const scratch = postgres(scratchUrl, { max: 1, onnotice: () => {} });
    try {
      console.log(`[build-reference-schema] applying migrations from ${SQL_DIR}…`);
      const { appliedCount, totalKnown, failed: failedMigrations } = await applyPendingMigrations({
        client: scratch,
        sqlDir: SQL_DIR,
        log: (s: string) => console.log(`[build-reference-schema] ${s}`),
      });
      console.log(`[build-reference-schema] applied ${appliedCount}/${totalKnown} migration(s)`);
      if (failedMigrations.length > 0) {
        failed = true;
        console.error(
          `[build-reference-schema] ${failedMigrations.length} migration(s) FAILED — the reference DB is INCOMPLETE:`,
        );
        for (const f of failedMigrations) console.error(`  • ${f.file}: ${f.error}`);
      }
    } finally {
      await scratch.end({ timeout: 5 });
    }

    if (!failed) {
      const u = new URL(scratchUrl);
      const pgDumpArgs = [
        '-h', u.hostname,
        '-p', u.port || '5432',
        '-U', u.username || 'harness_admin',
        '-w',
        '-d', dbName,
        '--schema-only',
        '--no-owner',
        '--no-privileges',
        ...args.schemas.flatMap((s) => ['--schema', s]),
        '-f', args.outRawPath,
      ];
      console.log(`[build-reference-schema] pg_dump --schema-only (${args.schemas.join(', ')}) → ${args.outRawPath}`);
      const result = spawnSync('pg_dump', pgDumpArgs, {
        env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password || 'harness_admin_pwd') },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      if (result.error) {
        failed = true;
        console.error(`[build-reference-schema] pg_dump spawn failed: ${result.error.message}`);
      } else if (result.status !== 0) {
        failed = true;
        console.error(`[build-reference-schema] pg_dump exited ${result.status}`);
      } else {
        console.log(`[build-reference-schema] done → ${args.outRawPath}`);
        console.log(
          '[build-reference-schema] next: npx tsx packages/operator-core/lib/db-tools/sanitize-baseline.ts ' +
            `${args.outRawPath} /tmp/000-baseline.sql`,
        );
      }
    }
  } finally {
    if (!args.keepDb) {
      const cleanup = postgres(base, { max: 1, onnotice: () => {} });
      try {
        await cleanup.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
        );
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    } else {
      console.log(`[build-reference-schema] --keep-db: leaving "${dbName}" in place`);
    }
  }

  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error('[build-reference-schema] fatal:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
