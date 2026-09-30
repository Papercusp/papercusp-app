#!/usr/bin/env node
/**
 * Drizzle drift check (Unlock 1 — "schema diff in CI").
 *
 * Runs `libs/papercusp/libs/db/scripts/pull-schema.mjs` against the live
 * PG instance and fails if the regenerated `generated.ts` /
 * `generated-relations.ts` differ from what's committed.
 *
 * This proves the source-of-truth is the `.sql` migrations: any
 * `.sql` change → re-run pull-schema → commit the diff. PRs that
 * forget to regenerate the schema will fail this check.
 *
 * Requires HARNESS_ADMIN_DATABASE_URL (or DATABASE_URL) to point at a PG
 * instance with all migrations applied. CI sets this via the same
 * testcontainers harness the integration tests use. Local devs can run
 * this against their dev PG.
 *
 * Exit codes:
 *   0   — no drift, schema files are up to date
 *   1   — drift detected (regenerated content differs from HEAD)
 *   2   — environment problem (DB unreachable, drizzle-kit broken, etc.)
 *
 * Usage:
 *   node scripts/check-drizzle-drift.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const SCHEMA_DIR = 'libs/papercusp/libs/db/src/schema';
const TARGETS = [
  `${SCHEMA_DIR}/generated.ts`,
  `${SCHEMA_DIR}/generated-relations.ts`,
];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit', ...opts });
  return r.status ?? 1;
}

console.log('==> drizzle drift check: regenerating schema from live DB');
const pullStatus = run('node', ['libs/papercusp/libs/db/scripts/pull-schema.mjs']);
if (pullStatus !== 0) {
  console.error('✗ pull-schema.mjs failed (DB unreachable / drizzle-kit broken?)');
  process.exit(2);
}

console.log('==> diffing regenerated schema vs HEAD');
const diffStatus = run('git', ['diff', '--exit-code', '--', ...TARGETS]);
if (diffStatus === 0) {
  console.log('✓ no drift — generated.ts is in sync with the live schema');
  process.exit(0);
}

console.error('');
console.error('✗ DRIFT DETECTED: the live schema differs from generated.ts/generated-relations.ts.');
console.error('');
console.error('  This usually means a `.sql` migration landed without re-running');
console.error('  `node libs/papercusp/libs/db/scripts/pull-schema.mjs` and committing');
console.error('  the regenerated files.');
console.error('');
console.error('  To fix locally:');
console.error('    node libs/papercusp/libs/db/scripts/pull-schema.mjs');
console.error('    git add libs/papercusp/libs/db/src/schema/generated*.ts');
console.error('    git commit');
console.error('');
process.exit(1);
