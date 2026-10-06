/**
 * Seed the `hosted-public-ingress-probe` routine — the standing check that every public route
 * family on the hosted origin reaches the hosted control plane rather than the session-gated portal
 * (WI-10004437; handler in `hosted-public-ingress-probe-action.ts`, logic in
 * `endpoint-route/hosted-public-ingress.ts`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`), for the same
 * reason as `seed-hosted-lifecycle-reconcile-routine.ts`: the tunnel ingress is an operator-level
 * substrate concern (one origin, one tunnel), not a per-blueprint-install cadence. Ephemeral rows
 * are armed by the per-host ephemeral executor (`../../dbos/ephemeral-executor.ts`) on boot.
 *
 * Why NOT a branch inside `hosted-lifecycle-reconcile`: that sweep's 120s cadence is derived from
 * its own stuck/orphan thresholds, and one tick of this probe is ~36 public HTTPS requests. Folding
 * it in would either spend that every two minutes or bend the reconciler's cadence away from the
 * thresholds it enforces.
 *
 * 900s cadence. The ingress changes only when someone edits the tunnel config, so the probe is a
 * tripwire, not a monitor: fifteen minutes bounds how long a newly broken rule goes unflagged, at
 * ~36 GETs per tick against the public origin.
 *
 * SEEDED ACTIVE by default ("finished work never ships dark", root CLAUDE.md). Its only side
 * effects are unauthenticated GETs and a read of the tunnel config. Pass `--inactive` to seed dark.
 *
 *   tsx seed-hosted-public-ingress-probe-routine.ts              # seed ACTIVE (default)
 *   tsx seed-hosted-public-ingress-probe-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name)). A re-run does NOT live-arm a host that is already
 * running (restart papercusp-bg-host to pick up a freshly-seeded row live).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.HOSTED_PUBLIC_INGRESS_PROBE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'hosted-public-ingress-probe';
const TARGET_ROLE = 'system:hosted-public-ingress-probe';
const DEFAULT_INTERVAL_SEC = 900;

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
      -- active intentionally NOT re-applied on conflict (mirrors seed-hosted-lifecycle-reconcile-routine.ts):
      -- a re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id   = EXCLUDED.workspace_id,
      updated_at     = now()
  `;
  console.log(
    `[seed-hosted-public-ingress-probe-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
      `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — hosted public-ingress probe. ` +
      (active
        ? 'Cadence seeded ACTIVE — restart papercusp-bg-host to live-arm on a host that was already up.'
        : 'Inactive — enable via the routines admin or re-run without --inactive.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed-hosted-public-ingress-probe-routine] failed:', error);
    process.exit(1);
  });
