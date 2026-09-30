/**
 * verify-baseline.ts — prove the squashed migration set builds the full schema.
 *
 * Plan: self-contained-migration-baseline-2026-06-02, Phase 1 (P-006 gate) / Phase 3 (P-011 basis).
 *
 * Exercises the REAL boot path against a throwaway pgvector container:
 *   1. create framework roles + the 3 extensions (mirrors embedded-pg boot P-004),
 *   2. applyPendingMigrations({ sqlDir }) — the actual runner — so only 000-baseline.sql
 *      (+ the skipped per-harness template) is applied,
 *   3. applyPendingMigrations AGAIN — must apply 0 (idempotent / already-tracked),
 *   4. re-apply 000-baseline.sql RAW a second time too — must be a clean no-op (0 errors),
 *   5. assert the harness_shared table count matches the expected baseline.
 *
 * Unlike build-reference-schema.ts this invokes NO ensureXxx() — that's the whole point:
 * it proves the migration set ALONE (post-squash) yields the complete schema, the
 * precondition for deleting ensure-schema (Phase 2).
 *
 *   Run:  cd apps/operator && npx tsx lib/db-tools/verify-baseline.ts
 *   Exit: 0 = gate green; 1 = gate failed (prints the reason).
 */
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { resolve } from 'node:path';
// eslint-disable-next-line import/no-relative-packages -- exercise the real boot-path runner
import { applyPendingMigrations } from '../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const REPO_ROOT = resolve(process.cwd(), '../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const EXPECTED_MIN_TABLES = 183; // harness_shared base tables in the complete baseline (-1: harness_health dropped, mig 171)
const EXPECTED_MIN_REACTIVE_TRIGGERS = 18; // emit_change_notify_trg on the reactive tables (migration 107)

const ROLES_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app') THEN CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero') THEN CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;`;
const EXT_DDL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;`;

function fail(msg: string): never {
  console.error(`[verify-baseline] ❌ ${msg}`);
  process.exit(1);
}

async function main() {
  console.log('[verify-baseline] starting pgvector/pgvector:pg16 …');
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('papercusp').withUsername('superuser').withPassword('superuser').start();
  const dsn = `postgresql://superuser:superuser@${container.getHost()}:${container.getPort()}/papercusp`;
  const appDsn = `postgresql://harness_app:harness_app_pwd@${container.getHost()}:${container.getPort()}/papercusp`;

  try {
    const sql = postgres(dsn, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(ROLES_DDL);
      await sql.unsafe(EXT_DDL);
      console.log('[verify-baseline] roles + extensions created (boot pre-step)');

      const first = await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });
      console.log(`[verify-baseline] run #1: applied ${first.appliedCount}/${first.totalKnown}`);
      if (first.appliedCount < 1) fail('run #1 applied 0 — 000-baseline.sql was not picked up');

      const second = await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });
      console.log(`[verify-baseline] run #2: applied ${second.appliedCount} (expect 0 — already tracked)`);
      if (second.appliedCount !== 0) fail(`run #2 applied ${second.appliedCount} — runner not idempotent`);

      // Re-apply the baseline RAW (not via the tracker) to prove statement-level idempotency.
      const baseline = await sql.unsafe(
        `SELECT pg_read_file('${resolve(SQL_DIR, '000-baseline.sql')}')`,
      ).catch(() => null);
      // pg_read_file may be restricted; fall back to fs.
      let baselineSql: string;
      if (baseline?.[0]?.pg_read_file) {
        baselineSql = baseline[0].pg_read_file as string;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        baselineSql = readFileSync(resolve(SQL_DIR, '000-baseline.sql'), 'utf8');
      }
      try {
        await sql.unsafe(baselineSql);
        console.log('[verify-baseline] raw re-apply of 000-baseline.sql: clean no-op ✓');
      } catch (e) {
        fail(`raw re-apply of 000-baseline.sql errored (not idempotent): ${(e as Error).message.split('\n')[0]}`);
      }

      const [{ tables }] = await sql.unsafe(
        `SELECT count(*)::int AS tables FROM information_schema.tables
         WHERE table_schema='harness_shared' AND table_type='BASE TABLE'`,
      );
      console.log(`[verify-baseline] harness_shared tables: ${tables} (expected ≥ ${EXPECTED_MIN_TABLES})`);
      if (tables < EXPECTED_MIN_TABLES) fail(`only ${tables} tables — baseline is incomplete`);

      // Triggers are NOT covered by a table/column/index/policy diff, so they were a
      // blind spot once (the dogfood emit_change_notify_trg reactivity triggers lived
      // only in runtime wireDogfoodTriggers()). Migration 107 moved them into the set;
      // assert they're present so the gap can't silently reopen.
      const [{ reactive }] = await sql.unsafe(
        `SELECT count(*)::int AS reactive FROM pg_trigger
         WHERE NOT tgisinternal AND tgname = 'emit_change_notify_trg'`,
      );
      console.log(`[verify-baseline] emit_change_notify_trg reactivity triggers: ${reactive} (expected ≥ ${EXPECTED_MIN_REACTIVE_TRIGGERS})`);
      if (reactive < EXPECTED_MIN_REACTIVE_TRIGGERS) {
        fail(`only ${reactive} emit_change_notify_trg triggers — reactivity triggers missing from the migration set (see migration 107)`);
      }

      // Schemas + grants were ALSO diff-gate blind spots (the reference dump was scoped to
      // 2 schemas + --no-privileges). Migration 109 closed them; assert here so they can't reopen.
      const schemas = await sql.unsafe(
        `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)`,
        [['harness_shared', 'papercusp_shared', 'papercusp_auth', 'audit']],
      );
      const got = schemas.map((r: { nspname: string }) => r.nspname).sort();
      console.log(`[verify-baseline] core global schemas: ${got.join(', ')}`);
      if (got.length < 4) fail(`missing core schemas — have [${got.join(', ')}], need harness_shared/papercusp_shared/papercusp_auth/audit (migration 109)`);
    } finally {
      await sql.end({ timeout: 5 });
    }

    // Grants: connect AS harness_app (the runtime app role) and confirm it can actually
    // read/write — a fresh boot must not leave the app role locked out (migration 109 Part B).
    const app = postgres(appDsn, { max: 1, onnotice: () => {} });
    try {
      await app.unsafe(`SELECT count(*) FROM harness_shared.harness_features_consolidated`);
      await app.unsafe(`SELECT count(*) FROM papercusp_auth.users`);
      console.log('[verify-baseline] harness_app can SELECT harness_shared + papercusp_auth ✓ (grants present)');
    } catch (e) {
      fail(`harness_app cannot access tables (grant gap — migration 109 Part B): ${(e as Error).message.split('\n')[0]}`);
    } finally {
      await app.end({ timeout: 5 });
    }

    console.log('[verify-baseline] ✅ GATE GREEN — migration set alone builds the full schema (+ triggers, schemas, grants), idempotently.');
  } finally {
    await container.stop();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('[verify-baseline] FAILED:', e?.stack ?? e); process.exit(1); });
