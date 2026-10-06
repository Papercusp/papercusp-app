/**
 * Seed the `task-reconcile` routine — the task manager's 30s reconcile cadence
 * (task-manager-no-escape-2026-07-27, P-011; handler in `task-reconcile-action.ts`,
 * logic in `../../task-manager/reconcile-tick.ts`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`),
 * for the same reason `seed-supervision-reconcile-routine.ts` is one: this is an
 * operator-HOME-level concern — the processes on ONE box — not a per-blueprint-install
 * cadence. Ephemeral rows are armed by the per-host ephemeral executor, never a bare
 * `setInterval` (`lint:no-raw-setinterval`).
 *
 * 30s rather than 60s: this cadence is also the METRICS sample rate for the pane, and
 * a minute-old RSS reading is not much use when you are trying to see which task is
 * eating the box right now. The tick is a cgroup-tree walk plus one bulk UPDATE — it
 * is cheap enough that halving the interval is not a real cost.
 *
 * SEEDED ACTIVE by default. The reconciler is REPORT-ONLY (plan D-010) — no kill, no
 * freeze, no restart — so arming the cadence is safe by construction, and "finished
 * work never ships dark" (root CLAUDE.md) applies to the cadence itself.
 *
 *   tsx seed-task-reconcile-routine.ts              # seed ACTIVE (default)
 *   tsx seed-task-reconcile-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name)). A re-run does NOT live-arm a host that
 * is already running: the bg-host process owning the ephemeral executor re-enumerates
 * active ephemeral rows at boot, so either boot picks it up or it needs
 * `systemctl --user restart papercup-bg-host`.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.TASK_RECONCILE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'task-reconcile';
const TARGET_ROLE = 'system:task-reconcile';
const DEFAULT_INTERVAL_SEC = 30;

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${NAME}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = JSON.stringify({ interval_sec: DEFAULT_INTERVAL_SEC });
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
    `[seed-task-reconcile-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
      `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — task-manager reconcile + metrics cadence. ` +
      (active
        ? 'Cadence seeded ACTIVE — restart papercusp-bg-host to live-arm a host that was already up.'
        : 'Inactive — enable via the routines admin or re-run without --inactive.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-task-reconcile-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
