/**
 * Seed the `worker-breaker-watch` routine — the embed sidecar's crash-breaker watch
 * cadence (WI-37700; handler in `worker-breaker-watch-action.ts`, logic in
 * `../../worker-breaker-watch.ts`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`) rather
 * than a per-install blueprint `triggers.schedule` entry — this is an operator-HOME-level
 * concern (the sidecar process on ONE box), not a per-blueprint-install generic cadence,
 * mirroring `seed-supervision-reconcile-routine.ts` / `hive-git-gc-routine.ts`'s
 * documented reasoning for the same deviation. Ephemeral rows are armed by the per-host
 * ephemeral executor (`../../dbos/ephemeral-executor.ts`) on boot — NOT a bare
 * `setInterval` (`lint:no-raw-setinterval`).
 *
 * CADENCE — 5 minutes, deliberately slower than supervision-reconcile's 60s. The state it
 * watches is a PERMANENT latch, not a transient: once tripped it stays tripped for the
 * life of the sidecar, so a tick can never miss it, and polling faster buys only a shorter
 * time-to-first-report on a degradation whose remedy (restart the unit) is scheduled work
 * rather than a page. Every tick is an HTTP GET against a warm loopback port.
 *
 * SEEDED ACTIVE by default: the action is strictly REPORT-ONLY — one coord broadcast on a
 * false→true edge, no restart path, no readiness gating, no owner-authority surface (same
 * class as gc-plan-runs / precompute-derived-reads). "Finished work never ships dark"
 * (root CLAUDE.md) applies to the cadence itself. Pass `--inactive` to seed dark.
 *
 *   tsx seed-worker-breaker-watch-routine.ts              # seed ACTIVE (default)
 *   tsx seed-worker-breaker-watch-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every routine in this
 * dir). A re-run does NOT live-arm a host that's already running — the bg-host process
 * that owns the ephemeral executor must re-enumerate active ephemeral rows, so either it
 * wasn't armed yet (boot picks it up) or it needs
 * `systemctl --user restart papercup-bg-host` to pick up a freshly-seeded row live.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.WORKER_BREAKER_WATCH_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'worker-breaker-watch';
const TARGET_ROLE = 'system:worker-breaker-watch';
/** See the CADENCE note in the header — the watched state is a permanent latch. */
const DEFAULT_INTERVAL_SEC = 300;

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
    `[seed-worker-breaker-watch-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
      `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — embed-sidecar crash-breaker watch. ` +
      (active
        ? 'Cadence seeded ACTIVE — restart papercusp-bg-host to live-arm on a host that was already up.'
        : 'Inactive — enable via the routines admin or re-run without --inactive.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-worker-breaker-watch-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
