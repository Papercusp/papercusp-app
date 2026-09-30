/**
 * prune-test-runs.ts — daily retention pruner.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-041.
 *
 * Calls the SQL function harness_shared.prune_test_runs(keep) created
 * in migration 083. Default keep=50 rows per (file_path, branch). Run
 * by the papercup-test-runs-prune.timer systemd-user unit (daily).
 *
 * Usage:
 *   tsx apps/operator/scripts/prune-test-runs.ts          # keep 50
 *   tsx apps/operator/scripts/prune-test-runs.ts --keep 100
 *
 * Fail-soft: a missing table or unreachable DB is logged and exits 0
 * (so the cron stays green when the dev DB isn't running).
 */

import postgres from 'postgres';

const url =
  process.env.HARNESS_ADMIN_DATABASE_URL ??
  process.env.PAPERCUSP_TEST_RUNS_DB_URL ??
  'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

function parseKeep(): number {
  const idx = process.argv.indexOf('--keep');
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return 50;
}

async function main(): Promise<void> {
  const keep = parseKeep();
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    const rows = await sql<{ prune_test_runs: number }[]>`
      SELECT harness_shared.prune_test_runs(${keep})
    `;
    const deleted = Number(rows[0]?.prune_test_runs ?? 0);
    process.stdout.write(`✓ prune-test-runs: kept ${keep}/file_path/branch · ${deleted} row(s) deleted\n`);
  } catch (e) {
    process.stdout.write(
      `⚠ prune-test-runs: skipped (${e instanceof Error ? e.message : String(e)})\n`,
    );
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* swallow */ }
  }
}

void main();
