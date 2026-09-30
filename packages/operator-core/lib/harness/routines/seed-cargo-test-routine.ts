/**
 * Seed the `cargo-test` routine (production-test-readiness-2026-07-06 P-009 /
 * WI-3206) — `system:cargo-test` → `cargo-test-action.ts`, which runs the desktop
 * shell's Rust/cargo native suite via `scripts/report-cargo-tests.mjs` and records
 * results into `harness_shared.test_runs` (framework='cargo').
 *
 * Hourly, offset from green-checkpoint (:15) and the doc-anchor reconcile /
 * session-dir-gc slots so it never contends with them for the same tick minute.
 *
 * Seeded ACTIVE by default: the action is read-only w.r.t. the repo (it only runs
 * `cargo test`, never mutates source) and self-gates to the operator-home
 * installSlug (a stray per-hive routine cleanly no-ops), so an active routine is
 * safe from the moment it exists — finished work never ships dark (CLAUDE.md).
 * `--inactive` seeds it off for an explicit dark launch.
 *
 *   tsx seed-cargo-test-routine.ts              # seed ACTIVE
 *   tsx seed-cargo-test-routine.ts --inactive    # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.CARGO_TEST_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Hourly at :45 — offset from green-checkpoint (:15) and session-dir-gc/doc-anchor
 *  reconcile so this never contends with them for the same tick minute. */
const CRON = '0 45 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'cargo-test';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify({ cron: CRON })}::text::jsonb,
            'system:cargo-test', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-cargo-test-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `hourly (:45) cargo test run of papercusp-desktop/src-tauri, recorded as framework=cargo. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with --active or the routines admin.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-cargo-test-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
