/**
 * Seed the `hetzner-orphan-frame-reaper` routine — WI-1442 fix (c) / WI-1628; design
 * in `hetzner-orphan-frame-reaper.ts`, handler in `hetzner-orphan-frame-reaper-action.ts`.
 *
 *   - `hetzner-orphan-frame-reaper` (every 30 min): destroys rig-named Hetzner VMs
 *     (hzdeb* / pcusp-fed-*) whose creating agent (Hetzner label `pcusp-owner`) is
 *     confirmed `ended` via coord:presence, and old enough to clear the grace window.
 *     SQL/API only; spawns no agent.
 *
 * Not flag-gated — a destructive reaper deleting real billed cloud VMs is the
 * "owner-authority" flags exception, so the SINGLE gate is this routine's own
 * `active` column, seeded FALSE. Idempotent (upsert). Recommended bring-up order:
 * `--active --dry-run` first to preview the candidate set, then drop dry_run.
 *
 *   tsx seed-hetzner-orphan-frame-reaper-routine.ts                    # seed INACTIVE
 *   tsx seed-hetzner-orphan-frame-reaper-routine.ts --active           # seed + enable
 *   tsx seed-hetzner-orphan-frame-reaper-routine.ts --active --dry-run # enable, preview only
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - dry_run (default false) — classify + log, destroy nothing.
 *   - min_age_hours (default 2) — grace window past a confirmed-ended owner.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.HETZNER_ORPHAN_REAPER_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 30 minutes — cheap (one Hetzner list call + a handful of presence reads);
 *  orphaned frames bill by the hour, so a half-hour cadence bounds the leak tightly. */
const CRON = '0 */30 * * * *';

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const dryRun = process.argv.includes('--dry-run');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'hetzner-orphan-frame-reaper';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON, dry_run: dryRun };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:hetzner-orphan-frame-reaper', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-hetzner-orphan-frame-reaper-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}, dry_run=${dryRun}) — ` +
      `half-hourly reap of dead-agent-owned Hetzner rig frames. ` +
      (active
        ? 'Cadence LIVE.'
        : 'Inactive — enable with --active (recommend --active --dry-run first) or the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-hetzner-orphan-frame-reaper-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
