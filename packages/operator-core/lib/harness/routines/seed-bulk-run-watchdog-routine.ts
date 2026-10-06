/**
 * Seed the `bulk-run-watchdog` routine — the bulk-run stall sweep's 300s cadence
 * (autonomous-inbox-resolution-2026-08-31 P-002; handler in
 * `bulk-run-watchdog-action.ts`, decision core in
 * `../../attention/bulk-run-watchdog.ts`, DB halves in
 * `../../attention/bulk-run-store.ts`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`)
 * rather than a per-install blueprint `triggers.schedule` entry — one bounded sweep
 * serves every workspace's runs, mirroring `seed-acceptance-grading-sweep-routine.ts`'s
 * documented reasoning. Ephemeral rows are armed by the per-host ephemeral executor
 * (`../../dbos/ephemeral-executor.ts`) on boot — NOT a bare `setInterval`
 * (`lint:no-raw-setinterval`).
 *
 * 300s cadence: it matches the store's `RUN_HEARTBEAT_STALE_MS`, so a run is noticed
 * within roughly one staleness window of going stale. The cadence deliberately cannot
 * decide an outcome — `strandStaleRun` re-evaluates the staleness predicate INSIDE its
 * own UPDATE ... WHERE, so an early tick simply matches nothing and a late one changes
 * only how long the strand took to notice, never whether it was correct.
 *
 * SEEDED ACTIVE by default: the sweep's only writes are (a) failing a run that is
 * already provably stale, which `restartRun` explicitly accepts and can resume with
 * every decided outcome preserved, and (b) recomputing counters from the run's own
 * rows — a derivation, not a judgement. It cannot start a run, dispatch an agent,
 * apply a terminal action to any attention item, or touch an item that was already
 * decided; those capabilities are absent from its dependency interface, not merely
 * unused. And "finished work never ships dark" (root CLAUDE.md). Pass `--inactive`
 * to seed dark instead.
 *
 *   tsx seed-bulk-run-watchdog-routine.ts              # seed ACTIVE (default)
 *   tsx seed-bulk-run-watchdog-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every routine in
 * this dir). A re-run does NOT live-arm a host that's already running (restart
 * papercup-bg-host to pick up a freshly-seeded row live).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { BULK_RUN_WATCHDOG_INTERVAL_SEC } from './bulk-run-watchdog-action';

const SLUG = process.env.BULK_RUN_WATCHDOG_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'bulk-run-watchdog';
const TARGET_ROLE = 'system:bulk-run-watchdog';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${NAME}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = JSON.stringify({ interval_sec: BULK_RUN_WATCHDOG_INTERVAL_SEC });
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at, workspace_id)
    VALUES (
      ${id}, ${SLUG}, ${NAME}, 'cron',
      ${triggerConfig}::text::jsonb, ${TARGET_ROLE},
      'skip', 'skip-old', ${active}, 'ephemeral', NULL, ${ws}
    )
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_kind   = EXCLUDED.trigger_kind,
      trigger_config = EXCLUDED.trigger_config,
      target_role    = EXCLUDED.target_role,
      tier           = EXCLUDED.tier,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id   = EXCLUDED.workspace_id,
      updated_at     = now()
  `;
  console.log(
    `[seed-bulk-run-watchdog-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
      `tier=ephemeral, interval=${BULK_RUN_WATCHDOG_INTERVAL_SEC}s) — bulk-run stall + counter-drift sweep. ` +
      (active
        ? 'Cadence seeded ACTIVE — restart papercusp-bg-host to live-arm on a host that was already up.'
        : 'Inactive — enable via the routines admin or re-run without --inactive.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(
      '[seed-bulk-run-watchdog-routine] FAILED:',
      e instanceof Error ? e.message : e,
    );
    process.exit(1);
  });
