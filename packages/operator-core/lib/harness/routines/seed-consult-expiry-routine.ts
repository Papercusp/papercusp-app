/**
 * Seed the `consult-expiry-sweep` routine — the consult lifecycle expiry sweep's
 * 300s cadence (get-feedback-relevance-consults-2026-08-16 P-005 / D-005; handler
 * in `consult-expiry-action.ts`, logic in `../../consult/consult-expiry-core.ts`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`)
 * rather than a per-install blueprint `triggers.schedule` entry — the sweep is an
 * operator-HOME-level substrate concern (ONE bounded sweep serves every
 * workspace's consult_state rows), not a per-blueprint-install cadence, mirroring
 * `seed-supervision-reconcile-routine.ts`'s documented reasoning. Ephemeral rows
 * are armed by the per-host ephemeral executor (`../../dbos/ephemeral-executor.ts`)
 * on boot — NOT a bare `setInterval` (`lint:no-raw-setinterval`).
 *
 * 300s cadence: the shortest latency contract is hard-blocked's 30m expiry, so a
 * 5-minute sweep bounds expiry-detection overshoot at ~17% of the contract — and
 * the hard-blocked park-key emit is what un-parks a requester whose responder
 * never answered, so the cadence must be well under that 30m.
 *
 * SEEDED ACTIVE by default: the sweep is bounded (LIMIT + SKIP LOCKED, partial
 * index), write-scoped to past-due open rows, and "finished work never ships
 * dark" (root CLAUDE.md). Its only wake path (the latched park-key emit) fires
 * solely for hard-blocked rows whose requester explicitly parked on that key.
 * Pass `--inactive` to seed dark instead.
 *
 *   tsx seed-consult-expiry-routine.ts              # seed ACTIVE (default)
 *   tsx seed-consult-expiry-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every
 * routine in this dir). A re-run does NOT live-arm a host that's already
 * running (restart papercup-bg-host to pick up a freshly-seeded row live).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.CONSULT_EXPIRY_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'consult-expiry-sweep';
const TARGET_ROLE = 'system:consult-expiry-sweep';
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
    `[seed-consult-expiry-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
      `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — consult expiry sweep cadence. ` +
      (active
        ? 'Cadence seeded ACTIVE — restart papercup-bg-host to live-arm on a host that was already up.'
        : 'Inactive — enable via the routines admin or re-run without --inactive.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-consult-expiry-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
