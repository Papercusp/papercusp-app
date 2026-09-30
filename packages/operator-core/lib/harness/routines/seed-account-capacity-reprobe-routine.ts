/**
 * Seed the `account-capacity-reprobe` routine — the scheduled walled-account re-probe's
 * 300s cadence (EI-21921833535413808; handler in `account-capacity-reprobe-action.ts`, logic
 * reused from `agent-tools/accounts/probe-capacity.ts`'s `runCapacityProbe`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`) rather than
 * a per-install blueprint `triggers.schedule` entry — the account pool is an operator-HOME-level
 * substrate concern (ONE bounded sweep serves every workspace's account rows), not a per-blueprint-
 * install cadence, mirroring `seed-consult-expiry-routine.ts`'s documented reasoning. Ephemeral
 * rows are armed by the per-host ephemeral executor (`../../dbos/ephemeral-executor.ts`) on boot —
 * NOT a bare `setInterval` (`lint:no-raw-setinterval`).
 *
 * 300s cadence: `walledOnly` bounds the per-tick cost to accounts already flagged full (typically
 * a handful across both providers), and each probe is "one minimal request" (a header read, not a
 * billed inference call) — so a 5-minute cadence recovers a false wall quickly without meaningfully
 * adding to upstream traffic. A genuinely-walled account is merely re-confirmed each tick (a 429
 * carries the true reset and changes nothing).
 *
 * SEEDED ACTIVE by default: the action is read-mostly (one probe request per already-walled
 * account) plus a narrowly-scoped write (the account-pool projection + gateway readmit) that only
 * ever CORRECTS a wall the account does not actually have — "finished work never ships dark" (root
 * CLAUDE.md). Pass `--inactive` to seed dark instead.
 *
 *   tsx seed-account-capacity-reprobe-routine.ts              # seed ACTIVE (default)
 *   tsx seed-account-capacity-reprobe-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every routine in this dir).
 * A re-run does NOT live-arm a host that's already running (restart papercup-bg-host to pick up a
 * freshly-seeded row live).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.ACCOUNT_CAPACITY_REPROBE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'account-capacity-reprobe';
const TARGET_ROLE = 'system:account-capacity-reprobe';
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
      -- active intentionally NOT re-applied on conflict (mirrors seed-consult-expiry-routine.ts):
      -- a re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id   = EXCLUDED.workspace_id,
      updated_at     = now()
  `;
  console.log(
    `[seed-account-capacity-reprobe-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
      `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — scheduled walled-account re-probe cadence. ` +
      (active
        ? 'Cadence seeded ACTIVE — restart papercup-bg-host to live-arm on a host that was already up.'
        : 'Inactive — enable via the routines admin or re-run without --inactive.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-account-capacity-reprobe-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
