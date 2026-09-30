/**
 * Seed the `supervision-reconcile` routine — the failed-unit reconciler's 60s cadence
 * (critical-process-supervisor-2026-07-04 P-002; handler in `supervision-reconcile-action.ts`,
 * logic in `../../supervision/unit-reconciler.ts`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`) rather than a
 * per-install blueprint `triggers.schedule` entry — this is an operator-HOME-level concern (the
 * systemd units on ONE box), not a per-blueprint-install generic cadence, mirroring
 * `hive-git-gc-routine.ts`'s documented reasoning for the same deviation. Ephemeral rows are
 * armed by the per-host ephemeral executor (`../../dbos/ephemeral-executor.ts`) on boot, under
 * `EPHEMERAL_CADENCE` (P-013/D-006) — NOT a bare `setInterval` (`lint:no-raw-setinterval`).
 *
 * SEEDED ACTIVE by default (unlike the other bespoke seeds in this directory, which default
 * inactive/human-confirmed): the reconciler's OWN restart action is separately gated by
 * `FLAGS.SUPERVISOR_AUTO_RESTART` (default ON, D-003) — arming just the PROBE+report cadence
 * here is safe-by-construction even before that flag is reviewed (report-only until it's on),
 * and "finished work never ships dark" (root CLAUDE.md) applies to the cadence itself, not just
 * the flag. Pass `--inactive` to seed dark instead (e.g. for a one-off manual bring-up review).
 *
 *   tsx seed-supervision-reconcile-routine.ts              # seed ACTIVE (default)
 *   tsx seed-supervision-reconcile-routine.ts --inactive    # seed dark
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every routine in this dir).
 * A re-run does NOT live-arm a host that's already running (see `unit-reconciler.ts`'s header
 * for the caveat: the bg-host process that owns the ephemeral executor must re-enumerate active
 * ephemeral rows — either it wasn't armed yet [boot picks it up] or it needs a restart
 * [`systemctl --user restart papercup-bg-host`] to pick up a freshly-seeded row live).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.SUPERVISION_RECONCILE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'supervision-reconcile';
const TARGET_ROLE = 'system:supervision-reconcile';
/** 60s cadence per ## Design's probe protocol (3 consecutive 15s-spaced failures ≈45s detection
 *  latency lives INSIDE service-health's probe layer this reuses via SUPERVISED_PROCESSES; the
 *  reconciler's own tick just needs to be frequent enough not to add much on top of that). */
const DEFAULT_INTERVAL_SEC = 60;

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
    `[seed-supervision-reconcile-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
      `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — failed-unit reconciler cadence. ` +
      (active
        ? 'Cadence seeded ACTIVE — restart papercup-bg-host to live-arm on a host that was already up.'
        : 'Inactive — enable via the routines admin or re-run without --inactive.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-supervision-reconcile-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
