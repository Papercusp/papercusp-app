#!/usr/bin/env node
/**
 * Apply the canonical sql/ migrations against an EXTERNAL Postgres named by
 * DATABASE_URL — the cloud-frame path (`cloud-deployment-layer-2026-06-06`).
 *
 * Frames run system PG 16 + pgvector (pgdg) instead of embedded-postgres:
 * `000-baseline.sql` hard-requires the `vector` type, and the npm-fetched
 * embedded distribution ships neither the extension .so nor headers to build
 * it (found live 2026-06-06). Same isolation (one PG per frame, D-007 spirit);
 * the operator resolves it via the DATABASE_URL fallback exactly like the
 * native-PG dev box.
 *
 * Env:
 *   DATABASE_URL          — admin DSN (required)
 *   PAPERCUSP_PG_SQL_DIR  — migrations dir (required)
 */
import postgres from 'postgres';
import { applyPendingMigrations } from '../src/migration-runner.js';

const url = process.env.DATABASE_URL;
const sqlDir = process.env.PAPERCUSP_PG_SQL_DIR;
if (!url || !sqlDir) {
  console.error('apply-migrations: DATABASE_URL and PAPERCUSP_PG_SQL_DIR are required');
  process.exit(2);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  // Extensions first — the baseline references pgcrypto/pg_trgm/vector types.
  await sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS vector;
  `);
  const result = await applyPendingMigrations({
    client: sql,
    sqlDir,
    log: (m) => console.log(`[apply-migrations] ${m}`),
  });
  console.log(`[apply-migrations] done: ${result.appliedCount} applied (${result.totalKnown} known)`);

  // Pre-mint the spawn-signing key: it otherwise mints on first VERIFY, but a
  // fresh install SIGNS first (the director's spawn-mcp write) — without the row
  // the very first agent invoke fails (claude -p --strict-mcp-config aborts on a
  // missing .mcp.json). Mirrors gym provisioning; found live 2026-06-07.
  const { randomBytes } = await import('node:crypto');
  await sql`
    INSERT INTO harness_shared.operator_secrets (name, value_b64, rotated_at)
    VALUES ('spawn-signing-key', ${randomBytes(32).toString('base64')}, now())
    ON CONFLICT (name) DO NOTHING
  `;
  console.log('[apply-migrations] spawn-signing-key present');
} finally {
  await sql.end();
}
